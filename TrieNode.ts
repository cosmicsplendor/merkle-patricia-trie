// ============================================================================
// trieNode.ts
//
// Pure Patricia trie logic: no RLP, no hashing, no Merkleization.
// A node is just a plain data shape; insert/get/delete are free functions
// that take a node in and return a (possibly differently-shaped) node out.
// ============================================================================

export type Nibble = number; // 0..15

// ---------------------------------------------------------------------------
// Node shapes
// ---------------------------------------------------------------------------

export interface LeafNode {
  type: 'leaf';
  path: Nibble[];   // remaining nibbles from here to the value
  value: string;    // opaque value payload (hex string, caller-defined)
}

export interface ExtensionNode {
  type: 'extension';
  path: Nibble[];   // shared nibbles, no branching along this stretch
  child: TrieNode;  // always resolves to a branch (directly or via another node)
}

export interface BranchNode {
  type: 'branch';
  children: TrieNode[]; // length 16, indexed by nibble 0x0..0xf
  value: string | null; // present if some key terminates exactly here
}

export type TrieNode = LeafNode | ExtensionNode | BranchNode | null;

// ---------------------------------------------------------------------------
// Nibble <-> byte conversion
// ---------------------------------------------------------------------------

export function bytesToNibbles(bytes: Uint8Array): Nibble[] {
  const nibbles: Nibble[] = new Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    nibbles[i * 2] = bytes[i] >> 4;
    nibbles[i * 2 + 1] = bytes[i] & 0x0f;
  }
  return nibbles;
}

export function nibblesToBytes(nibbles: Nibble[]): Uint8Array {
  if (nibbles.length % 2 !== 0) {
    throw new Error('nibblesToBytes: nibble array must have even length');
  }
  const bytes = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1];
  }
  return bytes;
}

// NOTE: this project's rlp.ts uses plain hex strings with NO '0x' prefix
// (the empty value is represented as ""). These helpers match that
// convention. If you swap in an rlp.ts that expects '0x', these two
// functions are the only place that needs to change.
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex; // tolerate 0x on input, never emit it
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  if (padded.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToNibbles(hex: string): Nibble[] {
  return bytesToNibbles(hexToBytes(hex));
}

// ---------------------------------------------------------------------------
// Hex-prefix (compact) encoding
//
// Squeezes two pieces of info that get lost once nibbles are packed into
// bytes: (a) leaf vs extension, (b) even vs odd nibble-length.
// Returns/accepts a NIBBLE array (always even length), not bytes -- pack to
// bytes separately via nibblesToBytes when you actually need wire format.
// ---------------------------------------------------------------------------

export function encodeHexPrefix(path: Nibble[], isLeaf: boolean): Nibble[] {
  const oddLen = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (oddLen ? 1 : 0);
  return oddLen ? [flag, ...path] : [flag, 0, ...path];
}

export function decodeHexPrefix(encoded: Nibble[]): { path: Nibble[]; isLeaf: boolean } {
  const flag = encoded[0];
  const isLeaf = (flag & 0b10) !== 0;
  const oddLen = (flag & 0b01) !== 0;
  const path = oddLen ? encoded.slice(1) : encoded.slice(2);
  return { path, isLeaf };
}

// ---------------------------------------------------------------------------
// Longest common prefix -- the one function nearly everything else reduces to
// ---------------------------------------------------------------------------

export function longestCommonPrefix(a: Nibble[], b: Nibble[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function nibblesEqual(a: Nibble[], b: Nibble[]): boolean {
  return a.length === b.length && longestCommonPrefix(a, b) === a.length;
}

// ---------------------------------------------------------------------------
// get -- read-only walk, no mutation, no shape changes
// ---------------------------------------------------------------------------

export function get(node: TrieNode, key: Nibble[]): string | null {
  if (node === null) return null;

  switch (node.type) {
    case 'leaf':
      return nibblesEqual(node.path, key) ? node.value : null;

    case 'extension': {
      if (key.length < node.path.length) return null;
      const prefix = key.slice(0, node.path.length);
      if (!nibblesEqual(prefix, node.path)) return null;
      return get(node.child, key.slice(node.path.length));
    }

    case 'branch':
      if (key.length === 0) return node.value;
      return get(node.children[key[0]], key.slice(1));
  }
}

// ---------------------------------------------------------------------------
// insert -- the three cases: full match / prefix-extend / split-and-branch
// ---------------------------------------------------------------------------

function emptyBranch(): BranchNode {
  return { type: 'branch', children: new Array(16).fill(null), value: null };
}

export function insert(node: TrieNode, key: Nibble[], value: string): TrieNode {
  if (node === null) {
    return { type: 'leaf', path: key, value };
  }

  switch (node.type) {
    case 'leaf':
      return insertAtLeafOrExtensionBoundary(node.path, node.value, key, value);

    case 'extension': {
      const lcp = longestCommonPrefix(node.path, key);

      if (lcp === node.path.length) {
        // Extension's whole path is shared -- just descend into its child
        // with whatever key remains.
        const newChild = insert(node.child, key.slice(lcp), value);
        return { type: 'extension', path: node.path, child: newChild };
      }

      // Split the extension at the divergence point.
      const branch = emptyBranch();
      const extRemainder = node.path.slice(lcp + 1);
      const extNibble = node.path[lcp];
      branch.children[extNibble] =
        extRemainder.length > 0
          ? { type: 'extension', path: extRemainder, child: node.child }
          : node.child;

      if (lcp === key.length) {
        branch.value = value;
      } else {
        const keyNibble = key[lcp];
        branch.children[keyNibble] = { type: 'leaf', path: key.slice(lcp + 1), value };
      }

      return lcp > 0 ? { type: 'extension', path: node.path.slice(0, lcp), child: branch } : branch;
    }

    case 'branch': {
      if (key.length === 0) {
        return { ...node, value };
      }
      const nibble = key[0];
      const rest = key.slice(1);
      const newChildren = node.children.slice();
      newChildren[nibble] = insert(node.children[nibble], rest, value);
      return { ...node, children: newChildren };
    }
  }
}

// Shared logic for inserting against a leaf's path (leaves and extension
// "remainders" both reduce to this same three-case split).
function insertAtLeafOrExtensionBoundary(
  existingPath: Nibble[],
  existingValue: string,
  key: Nibble[],
  value: string
): TrieNode {
  const lcp = longestCommonPrefix(existingPath, key);

  // Full match: same key, just overwrite the value in place.
  if (lcp === existingPath.length && lcp === key.length) {
    return { type: 'leaf', path: existingPath, value };
  }

  const branch = emptyBranch();

  // Existing leaf's path fully consumed by the shared prefix (new key keeps
  // going past it) -> its value moves onto the branch's own value slot.
  if (lcp === existingPath.length) {
    branch.value = existingValue;
  } else {
    const nibble = existingPath[lcp];
    branch.children[nibble] = { type: 'leaf', path: existingPath.slice(lcp + 1), value: existingValue };
  }

  // New key fully consumed by the shared prefix (it's shorter, terminates
  // exactly at the split) -> its value also lands on the branch's value slot.
  if (lcp === key.length) {
    branch.value = value;
  } else {
    const nibble = key[lcp];
    branch.children[nibble] = { type: 'leaf', path: key.slice(lcp + 1), value };
  }

  return lcp > 0 ? { type: 'extension', path: existingPath.slice(0, lcp), child: branch } : branch;
}

// ---------------------------------------------------------------------------
// delete -- reverse of insert: branches can collapse back into extension/leaf
// ---------------------------------------------------------------------------

export function del(node: TrieNode, key: Nibble[]): TrieNode {
  if (node === null) return null;

  switch (node.type) {
    case 'leaf':
      return nibblesEqual(node.path, key) ? null : node;

    case 'extension': {
      if (key.length < node.path.length) return node;
      const prefix = key.slice(0, node.path.length);
      if (!nibblesEqual(prefix, node.path)) return node;

      const newChild = del(node.child, key.slice(node.path.length));
      if (newChild === null) return null; // shouldn't normally happen (extension always wraps a branch)
      return mergeAfterExtension(node.path, newChild);
    }

    case 'branch': {
      if (key.length === 0) {
        return normalizeBranch({ ...node, value: null });
      }
      const nibble = key[0];
      const rest = key.slice(1);
      const newChildren = node.children.slice();
      newChildren[nibble] = del(node.children[nibble], rest);
      return normalizeBranch({ ...node, children: newChildren });
    }
  }
}

// After a branch mutates, check whether it needs to collapse.
function normalizeBranch(branch: BranchNode): TrieNode {
  let count = 0;
  let onlyIndex = -1;
  for (let i = 0; i < 16; i++) {
    if (branch.children[i] !== null) {
      count++;
      onlyIndex = i;
    }
  }

  if (count === 0 && branch.value === null) {
    return null; // fully empty
  }
  if (count === 0 && branch.value !== null) {
    // No children left, but a value remains -> collapse to a leaf.
    return { type: 'leaf', path: [], value: branch.value };
  }
  if (count === 1 && branch.value === null) {
    // Exactly one child, no value of its own -> fold the nibble into the
    // child's path (branch disappears, replaced by extension/leaf/branch).
    return prependNibble(onlyIndex, branch.children[onlyIndex]);
  }
  // 2+ children, or 1 child alongside a value: still a genuine branch.
  return branch;
}

function prependNibble(nibble: Nibble, child: TrieNode): TrieNode {
  if (child === null) throw new Error('prependNibble: unexpected null child');
  switch (child.type) {
    case 'leaf':
      return { type: 'leaf', path: [nibble, ...child.path], value: child.value };
    case 'extension':
      return { type: 'extension', path: [nibble, ...child.path], child: child.child };
    case 'branch':
      return { type: 'extension', path: [nibble], child };
  }
}

// After an extension's child changes, its child may have collapsed into
// something that lets the extension itself merge/disappear.
function mergeAfterExtension(parentPath: Nibble[], child: TrieNode): TrieNode {
  if (child === null) throw new Error('mergeAfterExtension: unexpected null child');
  switch (child.type) {
    case 'leaf':
      return { type: 'leaf', path: [...parentPath, ...child.path], value: child.value };
    case 'extension':
      return { type: 'extension', path: [...parentPath, ...child.path], child: child.child };
    case 'branch':
      return { type: 'extension', path: parentPath, child };
  }
}