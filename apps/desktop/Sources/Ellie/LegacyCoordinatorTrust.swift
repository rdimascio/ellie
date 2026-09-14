import Foundation
import Security

/// Recognizes only the extension-free certificate emitted by the original
/// coordinator-v1 generator. Trust evaluation still verifies the exact pinned
/// leaf, validity, self-signature, and private-key possession during TLS.
func legacyCoordinatorCertificate(_ certificate: SecCertificate) -> Bool {
  let bytes = [UInt8](SecCertificateCopyData(certificate) as Data)
  guard (1...16_384).contains(bytes.count), let profile = legacyCoordinatorDER(bytes) else {
    return false
  }
  guard let key = SecCertificateCopyKey(certificate),
    let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
    let keyType = attributes[kSecAttrKeyType] as CFTypeRef?,
    CFEqual(keyType, kSecAttrKeyTypeRSA),
    let keyBits = attributes[kSecAttrKeySizeInBits] as? NSNumber,
    keyBits.intValue >= 2_048
  else { return false }
  return SecKeyVerifySignature(
    key, .rsaSignatureMessagePKCS1v15SHA256,
    Data(bytes[profile.tbs]) as CFData, Data(bytes[profile.signature]) as CFData, nil)
}

private struct LegacyCoordinatorProfile {
  let tbs: Range<Int>
  let signature: Range<Int>
}

private struct DERValue {
  let tag: UInt8
  let encoded: Range<Int>
  let content: Range<Int>
}

private struct DERReader {
  let bytes: [UInt8]
  let end: Int
  var offset: Int

  init(_ bytes: [UInt8], range: Range<Int>? = nil) {
    self.bytes = bytes
    let range = range ?? bytes.indices
    offset = range.lowerBound
    end = range.upperBound
  }

  var isAtEnd: Bool { offset == end }

  mutating func read() -> DERValue? {
    let start = offset
    guard offset < end else { return nil }
    let tag = bytes[offset]
    offset += 1
    guard offset < end else { return nil }
    let firstLength = bytes[offset]
    offset += 1
    let length: Int
    if firstLength & 0x80 == 0 {
      length = Int(firstLength)
    } else {
      let count = Int(firstLength & 0x7f)
      guard (1...3).contains(count), offset + count <= end, bytes[offset] != 0 else {
        return nil
      }
      var value = 0
      for byte in bytes[offset..<(offset + count)] {
        guard value <= (Int.max - Int(byte)) / 256 else { return nil }
        value = value * 256 + Int(byte)
      }
      guard value >= 128 else { return nil }
      offset += count
      length = value
    }
    guard length <= end - offset else { return nil }
    let content = offset..<(offset + length)
    offset += length
    return DERValue(tag: tag, encoded: start..<offset, content: content)
  }
}

private func legacyCoordinatorDER(_ bytes: [UInt8]) -> LegacyCoordinatorProfile? {
  var certificate = DERReader(bytes)
  guard let outer = certificate.read(), outer.tag == 0x30, certificate.isAtEnd else { return nil }
  var fields = DERReader(bytes, range: outer.content)
  guard let tbs = fields.read(), tbs.tag == 0x30,
    let signatureAlgorithm = fields.read(), signatureAlgorithm.tag == 0x30,
    let signature = fields.read(), signature.tag == 0x03,
    fields.isAtEnd,
    sha256WithRSA(bytes, signatureAlgorithm),
    signature.content.count > 1, bytes[signature.content.lowerBound] == 0
  else { return nil }

  var tbsFields = DERReader(bytes, range: tbs.content)
  guard let serial = tbsFields.read(), serial.tag == 0x02,
    let tbsSignature = tbsFields.read(), tbsSignature.tag == 0x30,
    sha256WithRSA(bytes, tbsSignature),
    let issuer = tbsFields.read(), issuer.tag == 0x30,
    let validity = tbsFields.read(), validity.tag == 0x30,
    let subject = tbsFields.read(), subject.tag == 0x30,
    let publicKey = tbsFields.read(), publicKey.tag == 0x30,
    tbsFields.isAtEnd,
    bytes[issuer.encoded] == bytes[subject.encoded],
    exactLegacyName(bytes, subject)
  else { return nil }
  return LegacyCoordinatorProfile(
    tbs: tbs.encoded, signature: (signature.content.lowerBound + 1)..<signature.content.upperBound)
}

private func sha256WithRSA(_ bytes: [UInt8], _ algorithm: DERValue) -> Bool {
  var fields = DERReader(bytes, range: algorithm.content)
  guard let identifier = fields.read(), identifier.tag == 0x06,
    Array(bytes[identifier.content]) == [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b],
    let null = fields.read(), null.tag == 0x05, null.content.isEmpty,
    fields.isAtEnd
  else { return false }
  return true
}

private func exactLegacyName(_ bytes: [UInt8], _ name: DERValue) -> Bool {
  var nameFields = DERReader(bytes, range: name.content)
  guard let set = nameFields.read(), set.tag == 0x31, nameFields.isAtEnd else { return false }
  var setFields = DERReader(bytes, range: set.content)
  guard let attribute = setFields.read(), attribute.tag == 0x30, setFields.isAtEnd else {
    return false
  }
  var attributeFields = DERReader(bytes, range: attribute.content)
  guard let identifier = attributeFields.read(), identifier.tag == 0x06,
    Array(bytes[identifier.content]) == [0x55, 0x04, 0x03],
    let value = attributeFields.read(), [0x0c, 0x13].contains(value.tag),
    attributeFields.isAtEnd,
    Array(bytes[value.content]) == Array("ellie.local".utf8)
  else { return false }
  return true
}
