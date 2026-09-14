import Foundation
import Security
import XCTest

@testable import Ellie

final class CoordinatorTransportTests: XCTestCase {
    private let referenceDate = Date(timeIntervalSince1970: 2_000_000)

    func testDecodesPreferredCapabilitiesAndIgnoresTelemetry() throws {
        let data = Data(#"[{"id":"living-room.mac_1","capabilities":["url.open"],"executionCapabilities":["app.open","window.place"],"lastSeen":1999999000,"telemetry":{"cpu":99},"computeCapabilities":{"model":"x"}}]"#.utf8)
        let nodes = try PinnedCoordinatorClient.decodeNodes(data, now: referenceDate)

        XCTAssertEqual(nodes, [CoordinatorNode(
            id: "living-room.mac_1",
            capabilities: ["app.open", "window.place"],
            lastSeen: Date(timeIntervalSince1970: 1_999_999)
        )])
    }

    func testUsesLegacyCapabilitiesAndDeduplicatesThem() throws {
        let data = Data(#"[{"id":"mac","capabilities":["url.open","url.open"],"lastSeen":2000000000}]"#.utf8)
        XCTAssertEqual(try PinnedCoordinatorClient.decodeNodes(data, now: referenceDate).first?.capabilities, ["url.open"])
    }

    func testRejectsMalformedOversizedAndExcessNodeResponses() {
        XCTAssertThrowsError(try PinnedCoordinatorClient.decodeNodes(Data("not json".utf8), now: referenceDate)) {
            XCTAssertEqual($0 as? CoordinatorFailure, .invalidResponse)
        }
        XCTAssertThrowsError(try PinnedCoordinatorClient.decodeNodes(
            Data(repeating: 0x20, count: PinnedCoordinatorClient.maximumResponseBytes + 1), now: referenceDate
        ))

        let node = #"{"id":"mac","capabilities":[],"lastSeen":2000000000}"#
        let data = Data(("[" + Array(repeating: node, count: 129).joined(separator: ",") + "]").utf8)
        XCTAssertThrowsError(try PinnedCoordinatorClient.decodeNodes(data, now: referenceDate))
    }

    func testRejectsInvalidIdentifiersCapabilitiesAndTimestamps() {
        let invalid = [
            #"[{"id":"bad id","capabilities":[],"lastSeen":2000000000}]"#,
            #"[{"id":"mac","capabilities":["shell.run"],"lastSeen":2000000000}]"#,
            #"[{"id":"mac","capabilities":[],"lastSeen":true}]"#,
            #"[{"id":"mac","capabilities":[],"lastSeen":2000005001}]"#,
            #"[{"id":"mac","lastSeen":2000000000}]"#,
        ]
        for document in invalid {
            XCTAssertThrowsError(try PinnedCoordinatorClient.decodeNodes(Data(document.utf8), now: referenceDate), document)
        }
    }

    func testOnlineWindowIncludesExactFreshnessAndFutureToleranceBounds() {
        XCTAssertTrue(node(lastSeen: referenceDate.addingTimeInterval(-60)).isOnline(at: referenceDate))
        XCTAssertFalse(node(lastSeen: referenceDate.addingTimeInterval(-60.001)).isOnline(at: referenceDate))
        XCTAssertTrue(node(lastSeen: referenceDate.addingTimeInterval(5)).isOnline(at: referenceDate))
        XCTAssertFalse(node(lastSeen: referenceDate.addingTimeInterval(5.001)).isOnline(at: referenceDate))
    }

    func testBuildsOnlyConfiguredHTTPSOriginRequest() throws {
        let connection = CoordinatorConnection(
            origin: URL(string: "https://192.0.2.4:8443")!, certificateDER: certificateDER, token: validToken
        )
        let request = try PinnedCoordinatorClient.makeRequest(connection: connection)
        XCTAssertEqual(request.url?.absoluteString, "https://192.0.2.4:8443/v1/nodes")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Ellie-Version"), "1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(validToken)")

    for unsafe in [
      "http://192.0.2.4", "https://user:pass@host", "https://host/other", "https://host?next=evil",
    ] {
      let value = CoordinatorConnection(
        origin: URL(string: unsafe)!, certificateDER: certificateDER, token: validToken)
            XCTAssertThrowsError(try PinnedCoordinatorClient.makeRequest(connection: value)) {
                XCTAssertEqual($0 as? CoordinatorFailure, .configurationUnsafe)
            }
        }
    }

    func testRejectsInvalidCertificateAndMissingCredentialBeforeLoading() async {
    let client = PinnedCoordinatorClient(loader: { _, _ in
      XCTFail("loader should not run")
      return (Data(), 200)
    })
        for connection in [
            CoordinatorConnection(origin: URL(string: "https://host")!, certificateDER: Data("bad".utf8), token: validToken),
            CoordinatorConnection(origin: URL(string: "https://host")!, certificateDER: certificateDER, token: ""),
        ] {
            do {
                _ = try await client.nodes(connection: connection)
                XCTFail("expected failure")
            } catch {
                XCTAssertTrue(error as? CoordinatorFailure == .invalidCertificate || error as? CoordinatorFailure == .credentialUnavailable)
            }
        }
    }

    func testRejectsCredentialsThatAreNotBoundedBearerTokens() {
    for token in [
      "a", String(repeating: "a", count: 65), String(repeating: "A", count: 64),
      String(repeating: "a", count: 63) + "\n",
    ] {
            let connection = CoordinatorConnection(
                origin: URL(string: "https://host")!, certificateDER: certificateDER, token: token
            )
            XCTAssertThrowsError(try PinnedCoordinatorClient.makeRequest(connection: connection)) {
                XCTAssertEqual($0 as? CoordinatorFailure, .credentialUnavailable)
            }
        }
    }

    func testHTTPFailuresAreFixedAndDoNotExposeResponseBody() async throws {
        let connection = validConnection()
    for (status, expected) in [
      (302, CoordinatorFailure.invalidResponse), (400, .invalidResponse), (401, .unauthorized),
      (403, .unauthorized), (500, .unavailable),
    ] {
      let client = PinnedCoordinatorClient(loader: { _, _ in
        (Data(#"{"error":"credential secret and server internals"}"#.utf8), status)
      })
            do {
                _ = try await client.nodes(connection: connection)
                XCTFail("expected failure")
            } catch {
                XCTAssertEqual(error as? CoordinatorFailure, expected)
                XCTAssertFalse(error.localizedDescription.contains("server internals"))
            }
        }
    }

    func testCancellationBecomesFixedCancelledFailure() async throws {
        let client = PinnedCoordinatorClient(loader: { _, _ in
            try await Task.sleep(for: .seconds(30))
            return (Data("[]".utf8), 200)
        })
        let task = Task { try await client.nodes(connection: validConnection()) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .cancelled)
        }
    }

  func testCoordinatorRequestImmediateCancellationDoesNotRaceStartup() async throws {
    let request = URLRequest(url: URL(string: "https://127.0.0.1:1/v1/nodes")!)
    for _ in 0..<100 {
      let operation = CoordinatorRequest(
        request: request, certificateDER: certificateDER, deadline: 1
      )
      let task = Task { try await operation.start() }
      task.cancel()
      operation.cancel()
      do {
        _ = try await task.value
        XCTFail("cancelled request completed")
      } catch is CancellationError {
      } catch {
        XCTAssertEqual(error as? CoordinatorFailure, .cancelled)
      }
    }
  }

    func testBuildsFiniteAppCommandRequestWithExpectedBodyAndHeaders() throws {
        let request = try PinnedCoordinatorClient.makeCommandRequest(
            connection: validConnection(), nodeID: "living-room.mac_1", app: .messages
        )
        XCTAssertEqual(request.url?.absoluteString, "https://127.0.0.1:8443/v1/commands")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.timeoutInterval, 35)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(validToken)")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(body, ["nodeId": "living-room.mac_1", "text": "open app Messages"])

        XCTAssertThrowsError(try PinnedCoordinatorClient.makeCommandRequest(
            connection: validConnection(), nodeID: "bad id", app: .arc
        ))
    }

    func testCommandValidatesSuccessAndNeverExposesServerMessage() async throws {
        let success = PinnedCoordinatorClient(loader: { _, _ in
            (Data(#"{"ok":true,"message":"private server detail"}"#.utf8), 200)
        })
        let outcome = try await success.openApp(connection: validConnection(), nodeID: "mac", app: .arc)
        XCTAssertEqual(outcome, .completed)

        for body in [
            #"{"ok":false,"message":"raw refusal reason"}"#,
            #"{"ok":true}"#,
            #"{"ok":1,"message":"bad"}"#,
            #"{"ok":"yes","message":"bad"}"#,
            #"{"ok":true,"message":"ok","extra":1}"#,
        ] {
            let client = PinnedCoordinatorClient(loader: { _, _ in (Data(body.utf8), 200) })
            do {
                _ = try await client.openApp(connection: validConnection(), nodeID: "mac", app: .safari)
                XCTFail("Expected unknown outcome")
            } catch {
                XCTAssertEqual(error as? NativeCommandFailure, .outcomeUnknown)
                XCTAssertFalse(error.localizedDescription.contains("raw refusal"))
            }
        }
    }

    func testCommandUsesFixedRejectionsAndTreatsOtherFailuresAsUnknown() async throws {
        let expected: [(Int, NativeCommandFailure)] = [
            (400, .rejected(.invalidRequest)), (401, .rejected(.unauthorized)),
            (403, .rejected(.forbidden)), (404, .rejected(.nodeNotFound)),
            (409, .rejected(.nodeUnavailable)), (500, .outcomeUnknown),
        ]
        for (status, failure) in expected {
            let client = PinnedCoordinatorClient(loader: { _, _ in
                (Data(#"{"error":"raw server secret"}"#.utf8), status)
            })
            do {
                _ = try await client.openApp(connection: validConnection(), nodeID: "mac", app: .arc)
                XCTFail("Expected failure")
            } catch {
                XCTAssertEqual(error as? NativeCommandFailure, failure)
                XCTAssertFalse(error.localizedDescription.contains("raw server secret"))
            }
        }
    }

    func testTrustRequiresExactLeafAndCertificateValidity() throws {
        let peer = try XCTUnwrap(SecCertificateCreateWithData(nil, certificateDER as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(peer, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        let peerTrust = try XCTUnwrap(trust)
        let validDate = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-14T00:00:00Z"))
        XCTAssertTrue(PinnedCoordinatorClient.validateServerTrust(peerTrust, pinnedCertificate: peer, at: validDate))

        let other = try XCTUnwrap(SecCertificateCreateWithData(nil, otherCertificateDER as CFData))
        XCTAssertFalse(PinnedCoordinatorClient.validateServerTrust(peerTrust, pinnedCertificate: other, at: validDate))
        XCTAssertFalse(PinnedCoordinatorClient.validateServerTrust(
            peerTrust, pinnedCertificate: peer,
            at: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-12T00:00:00Z"))
        ))
        XCTAssertFalse(PinnedCoordinatorClient.validateServerTrust(
            peerTrust, pinnedCertificate: peer,
            at: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z"))
        ))
    }

    func testRedirectDelegateRefusesForwardingAuthorizedRequest() throws {
        let original = try PinnedCoordinatorClient.makeRequest(connection: validConnection())
        let operation = CoordinatorRequest(request: original, certificateDER: certificateDER)
        let redirected = URLRequest(url: URL(string: "https://attacker.invalid/v1/nodes")!)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: original.url!, statusCode: 302, httpVersion: "HTTP/1.1",
            headerFields: ["Location": redirected.url!.absoluteString]
        ))
        let refused = expectation(description: "redirect callback")
        operation.urlSession(URLSession.shared, task: URLSession.shared.dataTask(with: original),
                             willPerformHTTPRedirection: response, newRequest: redirected) { request in
            XCTAssertNil(request)
            refused.fulfill()
        }
        wait(for: [refused], timeout: 1)
    }

    private func node(lastSeen: Date) -> CoordinatorNode {
        CoordinatorNode(id: "mac", capabilities: [], lastSeen: lastSeen)
    }

    private func validConnection() -> CoordinatorConnection {
        CoordinatorConnection(origin: URL(string: "https://127.0.0.1:8443")!, certificateDER: certificateDER, token: validToken)
    }

    private var validToken: String { String(repeating: "a", count: 64) }

    private var certificateDER: Data {
        Data(base64Encoded: "MIIC3jCCAcagAwIBAgIJANN4W/GG/USyMA0GCSqGSIb3DQEBCwUAMBYxFDASBgNVBAMMC2VsbGllLmxvY2FsMB4XDTI2MDkxMzA3NDIyM1oXDTI2MDkxNTA3NDIyM1owFjEUMBIGA1UEAwwLZWxsaWUubG9jYWwwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7HR1tgm0qfNRaNmvJLFTIn8yMAO9UzB4kY/IWyrB070LP2PiD36uxOh+hTp4/q9x833qsdgv1tnA3xsy11Ko7S3D7yfeKlONpoYnh6X/ZXeMS+/yRQ7r5k5rArsZAR0JGulhWrMadOAGrWflKJ/iN0cmn6ntQ0SMT4fFbXFH+aHSnujJrzgibt8sVPN6TZO4txAkL4b9ye1kEmJfJGkWm/aGIVriHODRj4GkJPStyXwf7xIuZApdPAjPz2E6/3jf3g/vQhco63adb8JJOt1GQ3dkRQgb1YQml2796iyXSzl9t++myLemwCY7kJkOuiGafpGCM5R6ELrLgQ1G1vz+3AgMBAAGjLzAtMBYGA1UdEQQPMA2CC2VsbGllLmxvY2FsMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0GCSqGSIb3DQEBCwUAA4IBAQAvHlBcX5HCTHQrLd0NCWkDiCKWNgD6o7qu25yAkrupNucr0XmiGulpwRBd+indbDiKc5pxAiMI/o6QD6LxEanmu2tJfMJwe2ngjgJNz8axPfXI7894+CywOUT+63HFPdWmsHP15+L3OyJoBion9eZLo/QdmWAEUrVyPVyp73dJuPsVzPvW4CIdUOEHyEotEkWT66uuRFnBsFU+ANRx5POpVCXafgcPflHwa+3WrjSU1JCJu/YHgN+sNiQTBCCEjnVcDukJQRIyQVol5VHx8TnjZArDC34FHv5l6ayyx2yAJjrJEWqiAKRXrYJQGrFpWYJWbaBUfvfcQgPULhnhcg6e")!
    }

    private var otherCertificateDER: Data {
        Data(base64Encoded: "MIIC4DCCAcigAwIBAgIJALxUDwm3nbCOMA0GCSqGSIb3DQEBCwUAMBYxFDASBgNVBAMMC2VsbGllLmxvY2FsMCAXDTI2MDkxMzA3NDgwOFoYDzIxMjYwODIwMDc0ODA4WjAWMRQwEgYDVQQDDAtlbGxpZS5sb2NhbDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOynvrCG03uf6KNXVi1fECVU/9VP/iiABOjl0NNQQ4apNIwL1aefSrRY7mfWOXF/wgrugf0qe3YbqKs2NAphu5SwSsUY56R+qZuPKF4T+84R64tOjC5YqO7NVymAvfvt6MQK+9GD5peWRzCZncrYSCYdW5wV+NwskYfarBOtGkXKmINYpW7DLdO0vT5sGX+6xB6zP5kO/aql0kBYDZLmHFjhjwYDYw+YDxge8XkjE1+8q+cdzw1w2dFPxxf5YGcax/68N+0zHBXYPpSGpJAlCbDC2GBLB3EPgvifHVULJOb8y+9z21jOvh5jQ3RVLPcCP+FlAo9+G3PLxzL+6Kv1uQMCAwEAAaMvMC0wFgYDVR0RBA8wDYILZWxsaWUubG9jYWwwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBAEMvnLp1LDIGo1WkWuVYrk0jZtJwjhzHV0K2UcCVjha8SJaDwwox5fujDM8kXBKiqdL4PvyrqUNIlO28ZzTy2JBYBkLDB/7ur4IvVhlt7kIAhGM4CXFfYUofefZq4Pnam+88UdaDGUyZkqKS54EOcdFKsX7mJ1yXp4zsmBnp4fpf7A4Z27WLh5kTBrnwcyGXYBI90ifKY8V94/gwqmZK4EmLJWtVeIHzAbyNmRIaGMQzV8eYnaeha+/B58Ne0n0X6hkaxMptJI7gfyXn/ozeWzYDwNmz0uwxG6z+BGlhOYhNVUXD3zuvuCsp49bzXMnTnPbNLr1AL62NPfdPH9Q7tlY=")!
    }
}
