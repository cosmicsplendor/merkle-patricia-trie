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
const metaSubspaces = {
    singleByte: { min: 0, max: 127 }, // subspace for single byte values, indicating this metadata is the data itself
    shortString: { min: 128, max: 128 + 55 }, // subspace for short strings, (metadata value in this range MINUS 128) gives the number of bytes the following string has 
    longString: { min: 184, max: 184 + 7 }, // this subspace indicates we're dealing with large strings that are out of previous shortsString range, (metadata value in this range MINUS 183) says whatever follows has this many bytes and these bytes are simply the length of the string that follows them 
    shortArray: { min: 192, max: 192 + 55 }, // subspace for short arrays, (metadata value in this range MINUS 191) gives the number of bytes the following array has
}

export const encode = (data: DecodedData): EncodedData => {
    return ""
}
export const decode = (data: EncodedData): DecodedData => {
    return ""
}