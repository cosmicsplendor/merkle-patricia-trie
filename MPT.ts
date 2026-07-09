// ============================================================================
// mpt.ts
//
// Merkleization layer on top of trieNode.ts. Knows nothing about the
// insert/get/delete algorithm itself -- only how to turn a node into its
// canonical RLP form and, from there, its hash. trieNode.ts stays reusable
// for a plain (non-Merkleized) Patricia trie if you ever want one.
//
// Hex convention: matches rlp.ts -- plain hex strings, NO '0x' prefix,
// empty value is "" (not "0x").
// ============================================================================

import { encode, decode } from './RLP.ts';
import type { EncodedData, DecodedData } from "./RLP.ts";
import { keccak256 } from 'js-sha3'; // npm install js-sha3

import type {   TrieNode, Nibble } from './TrieNode.ts';
import {
  insert,
  get,
  del,
  encodeHexPrefix,
  decodeHexPrefix,
  nibblesToBytes,
  bytesToNibbles,
  hexToNibbles,
  hexToBytes,
  bytesToHex,
} from './TrieNode.ts';

const EMPTY_VALUE: DecodedData = '';
const HASH_LENGTH_THRESHOLD = 32; // bytes; below this, embed inline instead of hashing

// Secure-mode keys get hashed then TRUNCATED to this many bytes before being
// walked as nibbles. Real Ethereum uses the full 32-byte keccak256 output
// (64 nibbles, max depth 64) -- we cap it at 4 bytes (8 nibbles, max depth 8)
// so the resulting tree stays small and drawable for the visualizer, while
// keeping the "keys are hashed" behavior intact. Bump this back to 32 for a
// spec-accurate secure trie.
const SECURE_KEY_BYTES = 4;

function hashHex(dataHex: string): string {
  const bytes = hexToBytes(dataHex);
  return keccak256(bytes);
}

function byteLengthOfHex(hex: string): number {
  return hex.length / 2;
}

// ---------------------------------------------------------------------------
// Node -> RLP-input conversion
// ---------------------------------------------------------------------------

/**
 * Produces the DecodedData shape for a node, ready to hand to rlp.encode().
 * Child pointers are resolved via childRef: either the child's own decoded
 * form embedded inline (if small), or its 32-byte keccak256 hash (if not).
 */
function nodeToRlpInput(node: TrieNode): DecodedData {
  if (node === null) return EMPTY_VALUE;

  switch (node.type) {
    case 'leaf': {
      const pathNibbles = encodeHexPrefix(node.path, true);
      const pathHex = bytesToHex(nibblesToBytes(pathNibbles));
      return [pathHex, node.value];
    }

    case 'extension': {
      const pathNibbles = encodeHexPrefix(node.path, false);
      const pathHex = bytesToHex(nibblesToBytes(pathNibbles));
      return [pathHex, childRef(node.child)];
    }

    case 'branch': {
      const items: DecodedData[] = node.children.map((child) => childRef(child));
      items.push(node.value !== null ? node.value : EMPTY_VALUE);
      return items;
    }
  }
}

function childRef(child: TrieNode): DecodedData {
  if (child === null) return EMPTY_VALUE;

  const decodedChild = nodeToRlpInput(child);
  const encodedChild = encode(decodedChild);

  if (byteLengthOfHex(encodedChild) < HASH_LENGTH_THRESHOLD) {
    return decodedChild; // small enough: embed the node's own structure inline
  }
  return hashHex(encodedChild); // otherwise: point at it by hash
}

// ---------------------------------------------------------------------------
// MerklePatriciaTrie
// ---------------------------------------------------------------------------

export interface MPTOptions {
  /**
   * "Secure" tries (as used for Ethereum's state/storage tries) hash the key
   * before walking the trie, so an attacker can't choose keys that build
   * pathologically long shared-prefix chains. Here the hash is truncated to
   * SECURE_KEY_BYTES bytes (see comment above) rather than the full 32.
   * Off by default.
   */
  secure?: boolean;
}

export class MerklePatriciaTrie {
  private root: TrieNode = null;
  private readonly secure: boolean;

  constructor(options: MPTOptions = {}) {
    this.secure = options.secure ?? false;
  }

  private keyToNibbles(key: string): Nibble[] {
    if (this.secure) {
      const fullHash = hashHex(key);
      const truncated = fullHash.slice(0, SECURE_KEY_BYTES * 2); // 2 hex chars per byte
      return hexToNibbles(truncated);
    }
    return hexToNibbles(key);
  }

  put(key: string, value: string): void {
    const nibbles = this.keyToNibbles(key);
    this.root = insert(this.root, nibbles, value);
  }

  get(key: string): string | null {
    const nibbles = this.keyToNibbles(key);
    return get(this.root, nibbles);
  }

  delete(key: string): void {
    const nibbles = this.keyToNibbles(key);
    this.root = del(this.root, nibbles);
  }

  /** Canonical root hash of the current trie state. */
  get rootHash(): string {
    if (this.root === null) {
      // Keccak256 of RLP-encoded empty value -- the well-known "empty trie" hash.
      return hashHex(encode(EMPTY_VALUE));
    }
    const rootInput = nodeToRlpInput(this.root);
    return hashHex(encode(rootInput));
  }

  /**
   * Walks the trie collecting the RLP-encoded bytes of every node touched
   * along the path to `key`. This is the proof a light client / verifier
   * would replay against a known root hash, without needing the full trie.
   */
  getProof(key: string): EncodedData[] {
    const nibbles = this.keyToNibbles(key);
    const proof: EncodedData[] = [];

    let node = this.root;
    let remaining = nibbles;

    while (node !== null) {
      const decoded = nodeToRlpInput(node);
      proof.push(encode(decoded));

      if (node.type === 'leaf') {
        break;
      } else if (node.type === 'extension') {
        remaining = remaining.slice(node.path.length);
        node = node.child;
      } else {
        // branch
        if (remaining.length === 0) break;
        node = node.children[remaining[0]];
        remaining = remaining.slice(1);
      }
    }

    return proof;
  }
}

/**
 * Verifies a proof (as produced by getProof) against a known root hash and
 * key, without needing access to the full trie -- just the proof nodes.
 * Returns the value if the proof checks out, or null if it doesn't
 * (hash mismatch, wrong key, malformed proof, or key genuinely absent).
 */
export function verifyProof(rootHash: string, key: string, proof: EncodedData[], secure = false): string | null {
  let expectedHash = rootHash;
  let remaining: Nibble[];
  if (secure) {
    const fullHash = hashHex(key);
    remaining = hexToNibbles(fullHash.slice(0, SECURE_KEY_BYTES * 2));
  } else {
    remaining = hexToNibbles(key);
  }

  for (const encodedNode of proof) {
    if (hashHex(encodedNode) !== expectedHash) {
      return null; // this proof node doesn't match what the parent committed to
    }

    const decoded = decode(encodedNode);
    if (!Array.isArray(decoded)) return null;

    if (decoded.length === 2) {
      // leaf or extension
      const [pathHex, valueOrRef] = decoded as [string, DecodedData];
      const pathNibbles = bytesToNibbles(hexToBytes(pathHex));
      const { path, isLeaf } = decodeHexPrefix(pathNibbles);

      if (remaining.length < path.length) return null;
      const prefix = remaining.slice(0, path.length);
      if (JSON.stringify(prefix) !== JSON.stringify(path)) return null;
      remaining = remaining.slice(path.length);

      if (isLeaf) {
        return remaining.length === 0 ? (valueOrRef as string) : null;
      }
      expectedHash = typeof valueOrRef === 'string' ? valueOrRef : hashHex(encode(valueOrRef));
    } else if (decoded.length === 17) {
      if (remaining.length === 0) {
        const value = decoded[16];
        return value === EMPTY_VALUE ? null : (value as string);
      }
      const nibble = remaining[0];
      remaining = remaining.slice(1);
      const childRefValue = decoded[nibble];
      expectedHash = typeof childRefValue === 'string' ? childRefValue : hashHex(encode(childRefValue));
    } else {
      return null; // malformed
    }
  }

  return null;
}