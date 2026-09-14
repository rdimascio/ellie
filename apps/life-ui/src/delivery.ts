import type { LifeRecord } from "./types";

export const deliveryLabel = (record: LifeRecord) => {
  if (!record.delivery) return undefined;
  const status = record.delivery.status;
  return status === "paused"
    ? "Future delivery paused"
    : status === "cancelled"
      ? "Future delivery cancelled"
      : status === "delivered"
        ? "Delivered"
        : status === "complete"
          ? "Complete"
          : status === "failed"
            ? "Delivery needs attention"
            : status === "skipped"
              ? "Delivery skipped"
              : status === "unknown"
                ? "Delivery status unavailable"
                : status === "running"
                  ? "Delivering now"
                  : "Scheduled";
};

export const occurrenceLabel = (record: LifeRecord) => {
  const occurrence = record.delivery?.occurrence;
  if (!occurrence) return undefined;
  const status = occurrence.status.replaceAll("_", " ");
  return `${!["succeeded", "failed", "cancelled", "expired", "unknown"].includes(occurrence.state) ? "Current" : "Last"} occurrence: ${status}`;
};
