class NodeUtils {

    static getNodeHexId(nodeId) {
        return "!" + parseInt(nodeId).toString(16);
    }

    static getNodeColour(nodeId) {
        // convert node id to a hex colour
        return "#" + (nodeId & 0x00FFFFFF).toString(16).padStart(6, '0');
    }

    static getNodeTextColour(nodeId) {

        // extract rgb components
        const r = (nodeId & 0xFF0000) >> 16;
        const g = (nodeId & 0x00FF00) >> 8;
        const b = nodeId & 0x0000FF;

        // calculate brightness
        const brightness = ((r * 0.299) + (g * 0.587) + (b * 0.114)) / 255;

        // determine text color based on brightness
        return brightness > 0.5 ? "#000000" : "#FFFFFF";

    }

}

export default NodeUtils;
