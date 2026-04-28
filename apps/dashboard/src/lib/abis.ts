// Minimal ABIs for on-chain calls from the dashboard. Hand-rolled rather
// than imported from forge artifacts so the build doesn't depend on
// `forge build` having been run.

export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const jobChannelAbi = [
  {
    type: "function",
    name: "openChannel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "address" },
      { name: "channelNonce", type: "uint64" },
      { name: "deposit", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "topUp",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cooperativeClose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "nonce", type: "uint64" },
      { name: "cumOwed", type: "uint256" },
      { name: "clientSig", type: "bytes" },
      { name: "nodeSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "challengeClose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "nonce", type: "uint64" },
      { name: "cumOwed", type: "uint256" },
      { name: "clientSig", type: "bytes" },
      { name: "nodeSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "channels",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "client", type: "address" },
          { name: "node", type: "address" },
          { name: "deposit", type: "uint256" },
          { name: "latestCumOwed", type: "uint256" },
          { name: "latestNonce", type: "uint64" },
          { name: "challengeDeadline", type: "uint64" },
          { name: "openedAt", type: "uint64" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
] as const;
