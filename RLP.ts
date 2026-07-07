type EncodedData = string;
type DecodedData = string | DecodedData[];

/**
 * PREREQ
 * dec from hex: parseInt(hexString, 16)
 * hex from dec: dec.toString(16)
 * 
 * BIG PICTURE
 * RLP encoding metadata is stored in the first byte of the encoded data
 * entire 8 bits space (0-255) of that first metadata byte is divided into 5 different subspaces as below 
 */
const metaSubspaces = { // first byte of RLP encoded data is metadata, and the rest is the actual data
    singleByte: { min: 0, max: 127 }, // subspace for single byte values less than 127 (0x80), indicating this metadata is the data itself
    shortString: { min: 128, max: 128 + 55 }, // subspace for short strings, (metadata value in this range MINUS 128) gives the number of bytes the following string has 
    longString: { min: 184, max: 184 + 7 }, // this subspace indicates we're dealing with large strings that are out of previous shortsString range, (metadata value in this range MINUS 183) says whatever follows has this many bytes and these bytes are simply the length of the string that follows them 
    shortArray: { min: 192, max: 192 + 55 }, // subspace for short arrays, (metadata value in this range MINUS 192) gives the number of bytes of encoded array contents that follow
    longArray: { min: 248, max: 248 + 7 } // this subspace indicates we're dealing with large arrays that are out of previous shortsArray range, (metadata value in this range MINUS 247) says whatever follows has this many bytes and these bytes are simply the length of the array contents that follow them
}

const toHex = (dec: number): string => {
    const hex = dec.toString(16);
    return hex.length % 2 === 1 ? `0${hex}` : hex;
}
const toDec = (hex: string): number => {
    return parseInt(hex, 16)
}

const getEncodedListItemsMeta = (encodedItems: string): EncodedData => {
    const bytesLength = encodedItems.length / 2; // each byte is represented by 2 hex characters
    if (bytesLength === 0) {
        return toHex(192); // empty list is represented by 0xc0
    }
    if (bytesLength <= 55) {
        return toHex(192 + bytesLength);
    }
    const lengthBytes = toHex(bytesLength);
    const lengthMeta = toHex(247 + lengthBytes.length * 0.5);
    return lengthMeta.concat(lengthBytes);
}

const getStringMeta = (data: string): string => {
    if (data.length % 2 !== 0) throw new Error("[GetStringMeta] Got odd hex string length");
    const bytesLength = data.length / 2;
    if (bytesLength === 0) {
        return toHex(128); // empty string is represented by 0x80
    }
    if (parseInt(data, 16) < 128) {
        return "";
    }
    if (bytesLength <= 55) {
        return toHex(128 + bytesLength);
    }
    const lengthBytes = toHex(bytesLength);
    const lengthMeta = toHex(183 + lengthBytes.length * 0.5);
    return lengthMeta.concat(lengthBytes);
}

export const encode = (data: DecodedData): EncodedData => {
    if (Array.isArray(data)) {
        const encodedItems = data.reduce((encodedItems: string, item: DecodedData) => {
            const encodedItem = encode(item);
            return encodedItems.concat(encodedItem);
        }, "")
        const prefix = getEncodedListItemsMeta(encodedItems);
        return prefix.concat(encodedItems);
    }
    const prefix = getStringMeta(data);
    return prefix.concat(data);
}

export const decodeWithConsumedLength = (data: EncodedData): [DecodedData, number] => {
    const firstByte = toDec(data.slice(0, 2));
    if (data.length === 2 && firstByte <= metaSubspaces.singleByte.max) {
        return [data, 2];
    }
    if (firstByte >= metaSubspaces.shortString.min && firstByte <= metaSubspaces.longString.max) {
        const nextItemStart = firstByte - metaSubspaces.shortString.min
        return [data.slice(2, nextItemStart), nextItemStart];
    }
    if (firstByte >= metaSubspaces.longString.min && firstByte <= metaSubspaces.longString.max) {
        const lengthOfLength = firstByte - metaSubspaces.longString.min + 1;
        const startOfData = 2 + lengthOfLength * 2;
        const lengthOfData = toDec(data.slice(2, startOfData));
        const nextItemStart = startOfData + lengthOfData * 2;
        const d = data.slice(startOfData, nextItemStart);
        return [d, nextItemStart];
    }
    let arrayItems = "";
    if (firstByte >= metaSubspaces.shortArray.min && firstByte <= metaSubspaces.shortArray.max) {
        // Implementation for decoding arrays
        const lengthOfData = firstByte - metaSubspaces.shortArray.min;
        arrayItems = data.slice(2, 2 + lengthOfData * 2);
    } else if (firstByte >= metaSubspaces.longArray.min && firstByte <= metaSubspaces.longArray.max) {
        const lengthOfLength = firstByte - metaSubspaces.longArray.min + 1;
        const startOfData = 2 + lengthOfLength * 2;
        const lengthOfData = toDec(data.slice(2, startOfData));
        arrayItems = data.slice(startOfData, startOfData + lengthOfData * 2);
    }

    const decodedArray:DecodedData = [];
    while (arrayItems.length > 0) {
        const [ decodedItem, nextItemStart ]= decodeWithConsumedLength(arrayItems);
        decodedArray.push(decodedItem);
        arrayItems = arrayItems.slice(nextItemStart);
    }
    return [decodedArray, data.length];
}

export const decode = (data: EncodedData): DecodedData => {
    return decodeWithConsumedLength(data)[0];
}