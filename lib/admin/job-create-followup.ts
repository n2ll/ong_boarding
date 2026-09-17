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

export type JobCreateOperationField = "collectionMode" | "collectionBagDate" | "returnPlace" | "returnDeadline";

const UNKNOWN_CONDITION = /미정|미확인|미기재|확인\s*필요|별도\s*확인|추후|협의/;
const NO_COLLECTION = /(?:수거|회수)\s*(?:업무|작업)?\s*(?:는|은|이|가|도|를)?\s*[:：]?\s*(?:없|없이|불필요|안\s*(?:함|합)|하지\s*않|[xX](?:\s|$))/;
const NO_RETURN = /반납\s*(?:업무|작업)?\s*(?:는|은|이|가|도|을)?\s*[:：]?\s*(?:없|없이|불필요|안\s*(?:함|합)|하지\s*않|[xX](?:\s|$))/;

/** Review hints from this draft only; absence of a hint is not a validation or a work assignment. */
export function missingJobCreateOperationFields(body: string): JobCreateOperationField[] {
  const clauses = body.split(/[\r\n.!?;,]+/).map((line) => line.trim()).filter((line) =>
    line && !/^\[[^\]]+\]$/.test(line)
      && !/^[\s#•*\-]*(?:배송|수거|회수|재방문|반납|·|\/|및|안내|업무|절차|:|\s)+$/.test(line),
  );
  const collection = clauses.filter((line) => /수거|회수/.test(line) && !NO_COLLECTION.test(line));
  const returns = clauses.filter((line) => /반납/.test(line) && !NO_RETURN.test(line));
  const knownCollection = collection.filter((line) => !UNKNOWN_CONDITION.test(line));
  const knownReturns = returns.filter((line) => !UNKNOWN_CONDITION.test(line));
  const missing: JobCreateOperationField[] = [];

  if (collection.length > 0) {
    if (!knownCollection.some((line) => /맞수거|재방문|별도\s*수거|배송\s*(?:중|시|과\s*함께|하면서)/.test(line))) {
      missing.push("collectionMode");
    }
    if (collection.some((line) => /가방|보냉백/.test(line))
      && !knownCollection.some((line) => /(?:전날|전일|당일|어제|오늘|[월화수목금토일]요일|\d{1,2}월\s*\d{1,2}일)\s*(?:사용한|배송한|배송된|분|의)?\s*(?:가방|보냉백)/.test(line))) {
      missing.push("collectionBagDate");
    }
  }
  if (returns.length > 0) {
    if (!knownReturns.some((line) =>
      /반납\s*(?:상세\s*)?(?:장소|주소|지점|거점|지)\s*[:：]\s*\S+/.test(line)
      || /[가-힣]+(?:로|길)\s*\d[^\r\n.!?]*반납/.test(line)
      || /(?:센터|거점|창고|지점|사무실|상차지|집결지|영업소|보관함)[^\r\n.!?]*반납/.test(line))) {
      missing.push("returnPlace");
    }
    if (!knownReturns.some((line) => /당일|익일|다음\s*날|\d{1,2}\s*시|\d{1,2}:\d{2}|배송\s*완료\s*(?:즉시|후)/.test(line))) {
      missing.push("returnDeadline");
    }
  }
  return missing;
}
