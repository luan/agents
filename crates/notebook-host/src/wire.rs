use anyhow::{Result, bail, ensure};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use uuid::Uuid;
use zeromq::ZmqMessage;

type Signature = Hmac<Sha256>;
const DELIMITER: &[u8] = b"<IDS|MSG>";
const MAX_MESSAGE: usize = 32 * 1024 * 1024;

pub fn encode(kind: &str, content: Value, key: &str) -> Result<(String, ZmqMessage)> {
    let id = Uuid::new_v4().to_string();
    let parts = [
        json!({"msg_id":id,"session":"pi-notebook","username":"pi","date":"","msg_type":kind,"version":"5.3"}),
        json!({}), json!({}), content,
    ].into_iter().map(|value| serde_json::to_vec(&value)).collect::<Result<Vec<_>, _>>()?;
    ensure!(
        parts.iter().map(Vec::len).sum::<usize>() <= MAX_MESSAGE,
        "Notebook request exceeds 32 MiB"
    );
    let mut mac = Signature::new_from_slice(key.as_bytes())?;
    for part in &parts {
        mac.update(part);
    }
    let mut frames = vec![
        Bytes::from_static(DELIMITER),
        Bytes::from(hex::encode(mac.finalize().into_bytes())),
    ];
    frames.extend(parts.into_iter().map(Bytes::from));
    Ok((
        id,
        ZmqMessage::try_from(frames).map_err(|_| anyhow::anyhow!("Empty Jupyter message"))?,
    ))
}

pub fn decode(message: ZmqMessage, key: &str) -> Result<Value> {
    let frames: Vec<_> = message.into_vec();
    ensure!(
        frames.iter().map(Bytes::len).sum::<usize>() <= MAX_MESSAGE,
        "Notebook response exceeds 32 MiB"
    );
    let Some(start) = frames.iter().position(|frame| frame.as_ref() == DELIMITER) else {
        bail!("Missing Jupyter delimiter")
    };
    ensure!(frames.len() >= start + 6, "Incomplete Jupyter message");
    let parts = &frames[start + 2..start + 6];
    let supplied = hex::decode(&frames[start + 1])?;
    let mut mac = Signature::new_from_slice(key.as_bytes())?;
    for part in parts {
        mac.update(part);
    }
    mac.verify_slice(&supplied)?;
    Ok(json!({
        "header": serde_json::from_slice::<Value>(&parts[0])?,
        "parent_header": serde_json::from_slice::<Value>(&parts[1])?,
        "metadata": serde_json::from_slice::<Value>(&parts[2])?,
        "content": serde_json::from_slice::<Value>(&parts[3])?,
    }))
}
