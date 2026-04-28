//! Tiny JSON-RPC client over `reqwest`. Just the methods auto-register needs.

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};

pub struct EthRpc {
    http: Client,
    url: String,
}

impl EthRpc {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            http: Client::new(),
            url: url.into(),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1,
        });
        let resp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("rpc {method} POST {} failed", self.url))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .with_context(|| format!("rpc {method} body read"))?;
        if !status.is_success() {
            return Err(anyhow!("rpc {method} HTTP {status}: {text}"));
        }
        let v: Value = serde_json::from_str(&text)
            .with_context(|| format!("rpc {method} parse: {text}"))?;
        if let Some(err) = v.get("error") {
            return Err(anyhow!("rpc {method} error: {err}"));
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| anyhow!("rpc {method}: no result field in {text}"))
    }

    pub async fn chain_id(&self) -> Result<u64> {
        let v = self.call("eth_chainId", json!([])).await?;
        parse_hex_u64(v.as_str().ok_or_else(|| anyhow!("chainId: not string"))?)
    }

    pub async fn nonce(&self, addr: &[u8; 20]) -> Result<u64> {
        let v = self
            .call(
                "eth_getTransactionCount",
                json!([addr_hex(addr), "pending"]),
            )
            .await?;
        parse_hex_u64(v.as_str().ok_or_else(|| anyhow!("nonce: not string"))?)
    }

    pub async fn max_priority_fee_per_gas(&self) -> Result<u128> {
        let v = self.call("eth_maxPriorityFeePerGas", json!([])).await?;
        parse_hex_u128(v.as_str().ok_or_else(|| anyhow!("priority fee: not string"))?)
    }

    pub async fn pending_base_fee(&self) -> Result<u128> {
        let v = self
            .call("eth_getBlockByNumber", json!(["pending", false]))
            .await?;
        let s = v
            .get("baseFeePerGas")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow!("pending block has no baseFeePerGas"))?;
        parse_hex_u128(s)
    }

    pub async fn estimate_gas(
        &self,
        from: &[u8; 20],
        to: &[u8; 20],
        data: &[u8],
        value: u128,
    ) -> Result<u64> {
        let v = self
            .call(
                "eth_estimateGas",
                json!([{
                    "from": addr_hex(from),
                    "to": addr_hex(to),
                    "data": bytes_hex(data),
                    "value": uint_hex(value),
                }]),
            )
            .await?;
        parse_hex_u64(v.as_str().ok_or_else(|| anyhow!("estimate_gas: not string"))?)
    }

    pub async fn eth_call(
        &self,
        to: &[u8; 20],
        data: &[u8],
        from: Option<&[u8; 20]>,
    ) -> Result<Vec<u8>> {
        let mut tx = serde_json::Map::new();
        tx.insert("to".into(), json!(addr_hex(to)));
        tx.insert("data".into(), json!(bytes_hex(data)));
        if let Some(f) = from {
            tx.insert("from".into(), json!(addr_hex(f)));
        }
        let v = self
            .call("eth_call", json!([Value::Object(tx), "latest"]))
            .await?;
        parse_hex_bytes(v.as_str().ok_or_else(|| anyhow!("eth_call: not string"))?)
    }

    pub async fn send_raw(&self, raw: &[u8]) -> Result<[u8; 32]> {
        let v = self
            .call("eth_sendRawTransaction", json!([bytes_hex(raw)]))
            .await?;
        let s = v.as_str().ok_or_else(|| anyhow!("send_raw: not string"))?;
        let bytes = parse_hex_bytes(s)?;
        if bytes.len() != 32 {
            return Err(anyhow!("send_raw: hash not 32 bytes: {s}"));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(out)
    }

    /// Returns Some(success) once mined, None while pending. `success` is the
    /// EIP-658 receipt status (true = no revert).
    pub async fn receipt_status(&self, hash: &[u8; 32]) -> Result<Option<bool>> {
        let h = format!("0x{}", hex::encode(hash));
        let v = self.call("eth_getTransactionReceipt", json!([h])).await?;
        if v.is_null() {
            return Ok(None);
        }
        let status_str = v
            .get("status")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow!("receipt missing status"))?;
        let status = parse_hex_u64(status_str)?;
        Ok(Some(status == 1))
    }

    /// Block until the tx mines. Polls every `poll_interval`. Errors on revert.
    pub async fn wait_for_receipt(
        &self,
        hash: &[u8; 32],
        poll_interval: std::time::Duration,
        timeout: std::time::Duration,
    ) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            if let Some(success) = self.receipt_status(hash).await? {
                if success {
                    return Ok(());
                }
                return Err(anyhow!(
                    "tx 0x{} reverted on-chain",
                    hex::encode(hash)
                ));
            }
            if start.elapsed() >= timeout {
                return Err(anyhow!(
                    "tx 0x{} not mined within {:?}",
                    hex::encode(hash),
                    timeout
                ));
            }
            tokio::time::sleep(poll_interval).await;
        }
    }
}

fn addr_hex(addr: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(addr))
}

fn bytes_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn uint_hex(v: u128) -> String {
    if v == 0 {
        return "0x0".to_string();
    }
    format!("0x{:x}", v)
}

fn parse_hex_u64(s: &str) -> Result<u64> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    if stripped.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(stripped, 16).with_context(|| format!("parse u64 hex: {s}"))
}

fn parse_hex_u128(s: &str) -> Result<u128> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    if stripped.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(stripped, 16).with_context(|| format!("parse u128 hex: {s}"))
}

fn parse_hex_bytes(s: &str) -> Result<Vec<u8>> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(stripped).with_context(|| format!("parse bytes hex: {s}"))
}
