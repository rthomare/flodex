//! Minimal RLP encoder. Just enough for EIP-1559 transaction encoding —
//! `encode_bytes`, `encode_list`, `encode_uint`. Spec:
//! <https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/>

/// Encode a byte string. Single bytes in [0x00, 0x7f] are themselves; longer
/// strings get a length prefix.
pub fn encode_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return vec![bytes[0]];
    }
    let mut out = encode_length(bytes.len(), 0x80);
    out.extend_from_slice(bytes);
    out
}

/// Encode a list whose items are already individually RLP-encoded.
pub fn encode_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload_len: usize = items.iter().map(|i| i.len()).sum();
    let mut out = encode_length(payload_len, 0xc0);
    for item in items {
        out.extend_from_slice(item);
    }
    out
}

/// Encode an unsigned integer as its big-endian byte string with leading
/// zeros stripped — zero is the empty string `0x80`.
pub fn encode_uint(value: u128) -> Vec<u8> {
    if value == 0 {
        return encode_bytes(&[]);
    }
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|&b| b != 0).unwrap_or(15);
    encode_bytes(&bytes[first..])
}

fn encode_length(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![offset + (len as u8)];
    }
    let len_bytes = len.to_be_bytes();
    let first = len_bytes.iter().position(|&b| b != 0).unwrap();
    let len_be = &len_bytes[first..];
    let mut out = Vec::with_capacity(1 + len_be.len());
    out.push(offset + 55 + (len_be.len() as u8));
    out.extend_from_slice(len_be);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Spec test vectors:
    // <https://github.com/ethereum/wiki/wiki/RLP> (archived)
    #[test]
    fn empty_string() {
        assert_eq!(encode_bytes(&[]), vec![0x80]);
    }

    #[test]
    fn single_low_byte() {
        assert_eq!(encode_bytes(&[0x00]), vec![0x00]);
        assert_eq!(encode_bytes(&[0x7f]), vec![0x7f]);
    }

    #[test]
    fn short_string() {
        assert_eq!(encode_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
    }

    #[test]
    fn long_string() {
        // 56 bytes → 0xb8 + 0x38 + ...
        let s = vec![b'a'; 56];
        let enc = encode_bytes(&s);
        assert_eq!(enc[0], 0xb8);
        assert_eq!(enc[1], 56);
        assert_eq!(&enc[2..], &s[..]);
    }

    #[test]
    fn empty_list() {
        assert_eq!(encode_list(&[]), vec![0xc0]);
    }

    #[test]
    fn list_of_strings() {
        let items = vec![encode_bytes(b"cat"), encode_bytes(b"dog")];
        // 0xc8, 0x83, 'c','a','t', 0x83, 'd','o','g'
        assert_eq!(
            encode_list(&items),
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
    }

    #[test]
    fn uint_zero() {
        assert_eq!(encode_uint(0), vec![0x80]);
    }

    #[test]
    fn uint_small() {
        assert_eq!(encode_uint(15), vec![0x0f]);
        assert_eq!(encode_uint(1024), vec![0x82, 0x04, 0x00]);
    }
}
