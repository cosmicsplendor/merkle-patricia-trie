import { encode as rlpEncode, decode as rlpDecode } from "./RLP.ts"

const payloads = [
    "12fc",
    "12",
    ["0b", "9234", [ "dead" ] ]
]

payloads.forEach(p => {
    console.log("Payload: ", p)
    console.log("Encoded: ", rlpEncode(p))
    console.log("Decoded: ", rlpDecode(rlpEncode(p)))
    console.log()
})