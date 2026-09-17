import type { GmailMessageDetail as Message } from "./api";

export function GmailMessageDetail({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) {
  return (
    <section className="gmail-message-detail" aria-label="Selected Gmail message">
      <div className="gmail-message-detail-heading">
        <h4>{message.subject}</h4>
        <button type="button" onClick={onClose}>
          Close message
        </button>
      </div>
      <dl>
        <dt>From</dt>
        <dd>{message.from || "Unavailable"}</dd>
        <dt>To</dt>
        <dd>{message.to.join(", ") || "Unavailable"}</dd>
        <dt>Date</dt>
        <dd>
          {Number.isFinite(message.sentAt) && message.sentAt > 0
            ? new Date(message.sentAt).toLocaleString()
            : "Unavailable"}
        </dd>
      </dl>
      {message.snippet && (
        <p>
          <strong>Preview snippet:</strong> {message.snippet}
        </p>
      )}
      {message.status === "unavailable" ? (
        <p>
          No inline plain-text body is available. Ellie does not render HTML or fetch attachments.
        </p>
      ) : (
        <>
          <p>
            {message.status === "truncated"
              ? "Plain-text body (truncated at 32 KiB)"
              : "Plain-text body"}
            {message.additionalPartsOmitted ? "; first inline part only" : ""}
          </p>
          <pre>{message.text}</pre>
        </>
      )}
    </section>
  );
}
