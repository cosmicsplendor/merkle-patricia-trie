import { encode as rlpEncode, decode as rlpDecode } from "./RLP.ts"
import type { DecodedData } from "./RLP.ts"

const payloads: DecodedData = [
    "12fc",
    "12",
    ["0b", "9234", [ "dead" ] ],
    "000001",
    Array(200).fill(1).join("")
]
payloads.push([...payloads])
payloads.forEach(p => {
    console.log("Payload: ", p)
    console.log("Encoded: ", rlpEncode(p))
    console.log("Decoded: ", rlpDecode(rlpEncode(p)))
    console.log()
})