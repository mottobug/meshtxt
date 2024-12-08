import GlobalState from "./GlobalState.js";
import {BleConnection, Constants, HttpConnection, Protobuf, SerialConnection, Types,} from "@meshtastic/js";
import Database from "./Database.js";
import NodeAPI from "./NodeAPI.js";
import PacketUtils from "./PacketUtils.js";
import FileTransferAPI from "./FileTransferAPI.js";

class Connection {

    static meshPacketListeners = [];
    static packetAckListeners = [];
    static clientNotificationListeners = [];
    static messageListeners = [];
    static traceRouteListeners = [];

    static addMeshPacketListener(listener) {
        this.meshPacketListeners.push(listener);
    }

    static removeMeshPacketListener(listenerToRemove) {
        this.meshPacketListeners = this.meshPacketListeners.filter((listener) => {
            return listener !== listenerToRemove;
        });
    }

    static addPacketAckListener(listener) {
        this.packetAckListeners.push(listener);
    }

    static removePacketAckListener(listenerToRemove) {
        this.packetAckListeners = this.packetAckListeners.filter((listener) => {
            return listener !== listenerToRemove;
        });
    }

    static addClientNotificationListener(listener) {
        this.clientNotificationListeners.push(listener);
    }

    static removeClientNotificationListener(listenerToRemove) {
        this.clientNotificationListeners = this.clientNotificationListeners.filter((listener) => {
            return listener !== listenerToRemove;
        });
    }

    static addMessageListener(listener) {
        this.messageListeners.push(listener);
    }

    static removeMessageListener(listenerToRemove) {
        this.messageListeners = this.messageListeners.filter((listener) => {
            return listener !== listenerToRemove;
        });
    }

    static addTraceRouteListener(listener) {
        this.traceRouteListeners.push(listener);
    }

    static removeTraceRouteListener(listenerToRemove) {
        this.traceRouteListeners = this.traceRouteListeners.filter((listener) => {
            return listener !== listenerToRemove;
        });
    }

    static async connectViaBluetooth() {

        // ensure browser supports web bluetooth
        if(!navigator.bluetooth){
            alert("Web Bluetooth is not supported in this browser");
            return;
        }

        await this.connect(new BleConnection(), {
            filters: [
                {
                    services: [
                        Constants.ServiceUuid,
                    ],
                },
            ],
        });

    }

    static async connectViaSerial() {

        // ensure browser supports web serial
        if(!navigator.serial){
            alert("Web Serial is not supported in this browser");
            return null;
        }

        await this.connect(new SerialConnection(), {
            concurrentLogOutput: true,
        });

    }

    static async connectViaHttp(address) {

        // check if address is https
        const isHttps = address.startsWith("https://");

        // get address without http:// and https://
        const [ _, addressWithoutScheme ] = address.split("://")

        // connect
        await this.connect(new HttpConnection(), {
            address: addressWithoutScheme,
            fetchInterval: 1000,
            tls: isHttps,
        });

    }

    static async connect(connection, connectionArgs) {

        // check if already connected
        if(GlobalState.isConnected){
            alert("Already connected");
            return;
        }

        // we are starting a new connection, so we want to allow config changes to happen
        GlobalState.isConfigComplete = false;

        // setup connection listeners
        await this.setupConnectionListeners(connection);

        // connect to device
        await connection.connect(connectionArgs);

        // update state
        GlobalState.connection = connection;
        GlobalState.isConnected = true;

    }

    static async disconnect() {

        // do nothing if already disconnected
        if(!GlobalState.isConnected){
            return;
        }

        // fix issue with http connection abort controller
        if(GlobalState.connection instanceof HttpConnection){
            // calling disconnect() on an HttpConnection during the initial config fetching locks up the web page
            // this is caused by an infinite loop of errors with the below message:
            // ERROR	[iMeshDevice:HttpConnection]	ReadFromRadio ❌ signal is aborted without reason
            // to fix this, we are just overwriting the internal abortController with a new instance that won't abort the pending internal http requests
            // this reliably fixes the issue and no longer locks up the page, however we still get packet callbacks until the config phase finishes
            // I don't really care if a few more packets come in after disconnecting, so this will do for now
            // fixme: this should probably be fixed in @meshtastic/js directly, probably by breaking out of the while loop if an abort error is received
            GlobalState.connection.abortController = new AbortController();
        }

        // disconnect
        GlobalState.connection.disconnect();

        // update ui
        GlobalState.isConnected = false;

    }

    static async setupConnectionListeners(connection) {

        // weird way to allow us to lock all other callbacks from doing anything, until the database is ready...
        // maybe we should use some sort of lock or mutex etc. basically, onMyNodeInfo is called with our node info
        // we use this to create a new database instance that is unique based on the node id.
        // initDatabase is async, which means all the other callbacks such as onChannelPacket are able to fire before the database is ready
        // this means when we try to access the database when it isn't ready yet, we get fun errors...
        // so we need to force the callbacks to wait until the database is ready
        // we will just resolve this promise when the database is ready, and all the packet callbacks should be set to await it
        var onDatabaseReady = null;
        const databaseToBeReady = new Promise((resolve) => {
            onDatabaseReady = resolve;
        });

        // listen for device status changes
        connection.events.onDeviceStatus.subscribe((deviceStatus) => {

            console.log("onDeviceStatus", deviceStatus);
            GlobalState.deviceStatus = deviceStatus;

            // check if device is now disconnected
            if(deviceStatus === Types.DeviceStatusEnum.DeviceDisconnected){
                this.disconnect();
            }

        });

        // listen for our node number
        connection.events.onMyNodeInfo.subscribe(async (data) => {
            console.log("onMyNodeInfo", data);
            GlobalState.myNodeId = data.myNodeNum;
            await Database.initDatabase(GlobalState.myNodeId);
            onDatabaseReady();
        });

        // listen for lora config
        connection.events.onConfigPacket.subscribe(async (configPacket) => {
            await databaseToBeReady;
            if(configPacket.payloadVariant.case.toString() === "lora"){
                GlobalState.loraConfig = configPacket.payloadVariant.value;
            }
        });

        // listen for packets from radio
        // we use this for some packets that don't have their own event listener
        GlobalState.myNodeFiles = [];
        connection.events.onFromRadio.subscribe(async (data) => {

            await databaseToBeReady;

            // handle packets
            // we are doing this to get error info for a request id as it's not provided in the onRoutingPacket event
            if(data.payloadVariant.case.toString() === "packet") {
                const meshPacket = data.payloadVariant.value;
                if(meshPacket.payloadVariant.case === "decoded"){
                    const dataPacket = meshPacket.payloadVariant.value;
                    if(dataPacket.portnum === Protobuf.Portnums.PortNum.ROUTING_APP){
                        // todo handle nack for "no channel" etc
                        const ackFrom = meshPacket.from;
                        const requestId = dataPacket.requestId;
                        const hopsAway = PacketUtils.getPacketHops(meshPacket);
                        await this.onPacketAck(requestId, ackFrom, hopsAway);
                    }
                }
            }

            // handle clientNotification
            if(data.payloadVariant.case.toString() === "clientNotification") {
                const clientNotification = data.payloadVariant.value;
                for(const clientNotificationListener of this.clientNotificationListeners){
                    try {
                        clientNotificationListener(clientNotification);
                    } catch(e){}
                }
            }

            // handle fileInfo
            if(data.payloadVariant.case.toString() === "fileInfo"){
                const fileInfo = data.payloadVariant.value;
                console.log("fileInfo", fileInfo);
                GlobalState.myNodeFiles.push(fileInfo);
            }

            // handle config complete
            if(data.payloadVariant.case.toString() === "configCompleteId"){

                console.log("config complete");
                GlobalState.isConfigComplete = true;

                // send current timestamp to meshtastic device
                // this allows it to send us an semi accurate rx timestamp for packets when we connect later on
                // if we don't set the time, the node may not know a time at all, in which case rxTime will be zero
                // or, the node might have a timestamp, but its drifted out of sync
                // so we will just send the node the current time each time we connect to it
                try {
                    const timestampInSeconds = Math.floor(Date.now() / 1000);
                    await NodeAPI.setTime(timestampInSeconds);
                } catch(e) {}

            }

        });

        // listen for node info
        GlobalState.nodesById = {};
        connection.events.onNodeInfoPacket.subscribe(async (data) => {

            await databaseToBeReady;

            console.log("onNodeInfoPacket", data);

            const nodeId = data.num;
            GlobalState.nodesById[nodeId] = data;

            // check if we found our own node info
            if(nodeId === GlobalState.myNodeId){
                GlobalState.myNodeUser = data.user;
                GlobalState.myNodeDeviceMetrics = data.deviceMetrics;
            }

        });

        // listen for mesh packets
        connection.events.onMeshPacket.subscribe(async (data) => {

            await databaseToBeReady;

            console.log("onMeshPacket", data);

            // pass mesh packet to all mesh packet listeners
            for(const meshPacketListener of this.meshPacketListeners){
                try {
                    meshPacketListener(data);
                } catch(e) {
                    console.log(e);
                }
            }

            // get packet data
            const rxTime = data.rxTime;
            const fromNodeId = data.from;

            // find node by id or do nothing
            const node = GlobalState.nodesById[fromNodeId];
            if(!node){
                return;
            }

            // update last heard and hops away for the node we received packet from
            node.lastHeard = rxTime;
            node.hopsAway = PacketUtils.getPacketHops(data);

        });

        // listen for user info
        connection.events.onUserPacket.subscribe(async (data) => {

            await databaseToBeReady;

            console.log("onUserPacket", data);

            // get packet data
            const fromNodeId = data.from;
            const user = data.data;

            // find node by id or do nothing
            const node = GlobalState.nodesById[fromNodeId];
            if(!node){
                return;
            }

            // update node user
            node.user = user;

            // todo add new nodes if they don't already exist

        });

        // listen for channels
        GlobalState.channelsByIndex = {};
        connection.events.onChannelPacket.subscribe(async (data) => {

            await databaseToBeReady;
            console.log("onChannelPacket", data);

            // ignore channel packets when not waiting for config, otherwise when fetching channels for remote nodes, it overwrites our local channels
            if(GlobalState.isConfigComplete){
                console.log("ignoring onChannelPacket as isConfigComplete is true");
                return;
            }

            // update local channels
            GlobalState.channelsByIndex[data.index] = data;

        });

        // listen for new messages
        connection.events.onMessagePacket.subscribe(async (data) => {
            await databaseToBeReady;
            console.log("onMessagePacket", data);
            await Database.Message.insert(data);
            for(const messageListener of this.messageListeners){
                try {
                    messageListener(data);
                } catch(e){}
            }
        });

        // listen for trace routes
        connection.events.onTraceRoutePacket.subscribe(async (data) => {
            await databaseToBeReady;
            console.log("onTraceRoutePacket", data);
            await Database.TraceRoute.insert(data);
            for(const traceRouteListener of this.traceRouteListeners){
                try {
                    traceRouteListener(data);
                } catch(e){}
            }
        });

        // listen for telemetry
        connection.events.onTelemetryPacket.subscribe(async (telemetryPacket) => {

            await databaseToBeReady;
            console.log("onTelemetryPacket", telemetryPacket);

            // find node this telemetry is from, otherwise do nothing
            const from = telemetryPacket.from;
            const node = GlobalState.nodesById[from];
            if(!node){
                return;
            }

            // update device metrics for node
            if(telemetryPacket.data.variant.case === "deviceMetrics"){
                const deviceMetrics = telemetryPacket.data.variant.value;
                node.deviceMetrics = deviceMetrics;
            }

        });

        // listen for positions
        connection.events.onPositionPacket.subscribe(async (positionPacket) => {

            await databaseToBeReady;
            console.log("onPositionPacket", positionPacket);

            // find node this position is from, otherwise do nothing
            const from = positionPacket.from;
            const node = GlobalState.nodesById[from];
            if(!node){
                return;
            }

            // update position for node
            node.position = positionPacket.data;

        });

        // listen for file transfer packets
        connection.events.onMeshPacket.subscribe(async (meshPacket) => {
            await databaseToBeReady;
            // try catch in case PRIVATE_APP is sent by something else and collides with invalid data
            try {

                // skip packet if it's node decoded
                if(meshPacket.payloadVariant.case !== "decoded"){
                    return;
                }

                // skip packet if it's not a PRIVATE_APP
                // todo replace with a proper portnum for file transfers?
                const data = meshPacket.payloadVariant.value;
                if(data.portnum !== Protobuf.Portnums.PortNum.PRIVATE_APP){
                    return;
                }

                // lookup protos
                const FileTransferPacket = await FileTransferAPI.getOrLoadFileTransferPacketProto();

                // decode file transfer packet proto
                const fileTransferPacket = FileTransferPacket.decode(data.payload);

                // call file transfer handler
                await this.onFileTransferPacket(meshPacket, fileTransferPacket);

            } catch(e) {
                console.log(e);
            }
        });

    }

    static async onPacketAck(requestId, ackedByNodeId, hopsAway) {

        console.log(`got ack for request id ${requestId} from ${ackedByNodeId}`);

        // send to packet ack listeners
        for(const packetAckListener of this.packetAckListeners){
            try {
                packetAckListener(requestId, ackedByNodeId, hopsAway);
            } catch(e){}
        }

        // todo make sure request id was for a message, otherwise we might be updating an older packet for something else
        await Database.Message.setMessageAckedByNodeId(requestId, ackedByNodeId);

    }

    static async onFileTransferPacket(meshPacket, fileTransferPacket) {

        console.log("onFileTransferPacket", fileTransferPacket);

        if(fileTransferPacket.offerFileTransfer){

            const fileTransferOffer = fileTransferPacket.offerFileTransfer;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === fileTransferOffer.id;
            });

            // create new file transfer if one doesn't already exist
            if(!fileTransfer){

                fileTransfer = {
                    id: fileTransferOffer.id,
                    to: meshPacket.to,
                    from: meshPacket.from,
                    direction: "incoming",
                    status: "offering",
                    filename: fileTransferOffer.fileName,
                    filesize: fileTransferOffer.fileSize,
                    progress: 0,
                    chunks: {},
                };

                GlobalState.fileTransfers.push(fileTransfer);

                console.log(`[FileTransfer] ${fileTransfer.id} offer received`);

            }

        } else if(fileTransferPacket.acceptFileTransfer){

            const acceptFileTransfer = fileTransferPacket.acceptFileTransfer;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === acceptFileTransfer.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} accepted`);

            // determine how many parts will be sent
            const maxAcceptablePartSize = acceptFileTransfer.maxAcceptablePartSize;
            const totalParts = Math.ceil(fileTransfer.data.length / maxAcceptablePartSize);

            // update file transfer status
            fileTransfer.status = "accepted";
            fileTransfer.total_parts = totalParts;
            fileTransfer.max_acceptable_part_size = maxAcceptablePartSize;

            // send first file part
            await this.sendFilePart(fileTransfer, 0);

        } else if(fileTransferPacket.rejectFileTransfer){

            const rejectFileTransfer = fileTransferPacket.rejectFileTransfer;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === rejectFileTransfer.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} rejected`);

            // update file transfer status
            fileTransfer.status = "rejected";

        } else if(fileTransferPacket.cancelFileTransfer){

            const cancelFileTransfer = fileTransferPacket.cancelFileTransfer;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === cancelFileTransfer.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} cancelled`);

            // remove cancelled file transfer if it was in offering state
            if(fileTransfer.status === "offering"){
                GlobalState.fileTransfers = GlobalState.fileTransfers.filter((existingFileTransfer) => {
                    return existingFileTransfer.id !== fileTransfer.id;
                });
                return;
            }

            // update file transfer status
            fileTransfer.status = "cancelled";

        } else if(fileTransferPacket.completedFileTransfer){

            const completedFileTransfer = fileTransferPacket.completedFileTransfer;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === completedFileTransfer.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} completed`);

            // update file transfer status
            fileTransfer.status = "complete";

        } else if(fileTransferPacket.filePart){

            const filePart = fileTransferPacket.filePart;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === filePart.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} received part ${filePart.partIndex + 1}/${filePart.totalParts}`);

            // cache received data
            fileTransfer.chunks[filePart.partIndex] = filePart.data;

            // update file transfer status
            fileTransfer.status = "receiving";
            fileTransfer.progress = Math.ceil((filePart.partIndex + 1) / filePart.totalParts * 100);

            // check if complete
            // todo, check if all chunks received, and request others if not?
            if(filePart.partIndex === filePart.totalParts - 1){
                fileTransfer.status = "complete";
                fileTransfer.blob = new Blob(Object.values(fileTransfer.chunks), {
                    type: "application/octet-stream",
                });
                await this.completeFileTransfer(fileTransfer);
                return;
            }

            // request next part
            const nextFilePartIndex = filePart.partIndex + 1;
            await this.requestFileParts(fileTransfer, [
                nextFilePartIndex,
            ]);

        } else if(fileTransferPacket.requestFileParts){

            const requestFileParts = fileTransferPacket.requestFileParts;

            // find existing file transfer
            let fileTransfer = GlobalState.fileTransfers.find((fileTransfer) => {
                return fileTransfer.id === requestFileParts.fileTransferId;
            });

            // do nothing if file transfer not found
            if(!fileTransfer){
                return;
            }

            console.log(`[FileTransfer] ${fileTransfer.id} requested file parts ${requestFileParts.partIndexes}.`);

            // send parts
            for(const partIndex of requestFileParts.partIndexes){

                console.log(`[FileTransfer] ${fileTransfer.id} sending part ${partIndex}`);

                // send file part
                await this.sendFilePart(fileTransfer, partIndex);

                // update file transfer progress
                fileTransfer.status = "sending";
                fileTransfer.progress = Math.ceil((partIndex + 1) / fileTransfer.total_parts * 100);

            }

        }

    }

    static async completeFileTransfer(fileTransfer) {
        try {

            // tell remote node we completed the file transfer
            await FileTransferAPI.completeFileTransfer(fileTransfer.from, fileTransfer.id);

        } catch(e) {
            console.log(e);
        }
    }

    static async requestFileParts(fileTransfer, partIndexes) {
        try {

            // ask remote node for parts
            await FileTransferAPI.requestFileParts(fileTransfer.from, fileTransfer.id, partIndexes);

        } catch(e) {
            console.log(e);
        }
    }

    static async sendFilePart(fileTransfer, partIndex) {
        try {

            // get data for this part
            const partSize = fileTransfer.max_acceptable_part_size;
            const start = partIndex * partSize;
            const end = start + partSize;
            const partData = fileTransfer.data.slice(start, end);

            // send part to remote node
            await FileTransferAPI.sendFilePart(fileTransfer.to, fileTransfer.id, partIndex, fileTransfer.total_parts, partData);

        } catch(e) {
            console.log(e);
        }
    }

}

export default Connection;
