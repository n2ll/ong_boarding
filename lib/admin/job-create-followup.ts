export type JobCreateFollowupField =
  | "capacity"
  | "pickupAddress"
  | "dropoffAddress"
  | "payInfo";

export function missingJobCreateFollowupFields({
  capacity,
  pickupAddress,
  dropoffAddress,
  payInfo,
}: {
  capacity: number | "";
  pickupAddress: string;
  dropoffAddress: string;
  payInfo: string;
}): JobCreateFollowupField[] {
  return [
    capacity === "" ? "capacity" : null,
    !pickupAddress.trim() ? "pickupAddress" : null,
    !dropoffAddress.trim() ? "dropoffAddress" : null,
    !payInfo.trim() ? "payInfo" : null,
  ].filter((field): field is JobCreateFollowupField => field !== null);
}
