# e2e channel-flow test

End-to-end test for the payment-channel layer: anvil → deploy contracts →
spawn coordinator + node → open channel → encrypted prompt → verify
receipt sig → cooperativeClose → assert USDC moved.

## Prereqs

In `$PATH`: `anvil`, `forge`, `cast`, `cargo`, `bun`.

Backend defaults to local llama-server with a tiny Qwen 0.5B (~400MB
first-run download from HF, free thereafter). Set `ANTHROPIC_API_KEY` to
switch to mock-tee with `claude-haiku-4-5` instead — faster startup, ~$0.0001
per run.

## Run

```bash
bun install                  # one-time, picks up tests/e2e as a workspace
bun run test:e2e             # from repo root
# or:
bun run --cwd tests/e2e test
```

Expected runtime: ~30s with `ANTHROPIC_API_KEY` set, 1–3 min with the
local backend (model download + llama-server startup).

## What it asserts

1. anvil + Deploy.s.sol produce contracts at the expected deterministic
   addresses (USDC=`0x5FbDB2…0aa3`, registry=`0xe7f1725E…0512`, channel=
   `0x9fE46736…a6e0` from a fresh anvil + DEPLOYER as account 0).
2. Node auto-registers on-chain (`registry.isActive(node) == true`).
3. `openChannel` locks the deposit; channel goes to `Open`.
4. `/execute` returns a `NodeSignedReceipt` whose `nodeSig` recovers to
   the on-chain registered node address.
5. `cooperativeClose` succeeds with the bilaterally-signed state.
6. USDC balances move correctly: node gains `cumOwed`, client loses
   `cumOwed` net (regains `deposit - cumOwed`).
7. Channel ends in `Closed` status on-chain.

## Failure modes worth knowing about

- **Address mismatch after Deploy** — anvil wasn't actually fresh, or the
  deployer used a non-zero nonce. Restart anvil and retry.
- **Node never registers** — auto-register code in `apps/node/src/eth/`
  reverted (insufficient ETH/USDC, RPC down, allowance race). Inspect the
  node stderr.
- **Receipt sig mismatch** — usually means the canonical-bytes layout
  drifted between Rust (`crates/protocol::canonical_channel_update_bytes`)
  and the contract's `abi.encode`. Re-derive both from the spec in
  `JobChannel.sol::updateDigest`.
- **Channel status not Open after openChannel** — registry's `isActive`
  was false at the moment of `openChannel`; node hadn't finished its
  on-chain register yet. The test waits for `isActive` first; if it still
  trips, raise the timeout.
