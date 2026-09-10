import type { ConsultationSourceMessage, RegionPreference } from "./consultation-types";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEARCH_INTENT = /(?:일자리|일감|공고|자리|배송|근무|일할\s*곳)(?:는|은|도|가|이|를|을)?\s*(?:혹시\s*)?(?:있|없|찾|원|구하|구해|가능|하나)|(?:일|근무|배송)(?:을|를)?\s*(?:하고|할)\s*(?:싶|수)|(?:선호|희망|원하는)\s*(?:근무\s*)?지역|(?:선호|희망)(?:해|합)|(?:원해|원합)|(?:일자리|일감|공고)[^.!?？\n]{0,24}(?:생기|나오|뜨)[^.!?？\n]{0,16}(?:알려|연락|안내)|(?:쪽|지역|에서|은|는|이|가|도)\s*(?:일자리를?\s*)?(?:원해|원합|좋아|좋겠)/;
const REGIONAL_AVAILABILITY = /[가-힣]{2,}(?:쪽|지역|근처|부근|방면)(?:에서는|에도|에는|에서|은|는|에|도)?\s*(?:없|있|하나|안\s*하)/;
const NOT_OWN_PREFERENCE = /(?:친구|지인|남편|아내|동생|형|누나|언니|오빠|아버지|어머니)(?:가|이|는|은|도|에게)|대신\s*물|라고\s*(?:물|했|하)|만약|가정|예를\s*들/;
const NEGATIVE_PREFERENCE = /싫|원하지|원치|선호하지|희망하지|관심(?:이|은|도)?\s*없|불가|어려|못\s*(?:가|하|해)|안\s*(?:가|하|원|돼|되)|말고|제외|필요\s*없/;

function includesRegion(text: string, region: string): boolean {
  // 공고명/문장 일부를 지역으로 잘라내지 않는다. 지역 목록을 하드코딩하지 않는다.
  return new RegExp(`(^|[^가-힣A-Za-z])${escapeRegExp(region)}(?:(?:특별자치시|특별자치도|광역시|특별시|시|군|구|도))?(?:쪽|지역|근처|부근|방면)?(?:입니다|이에요|예요|에서는|에서도|으로는|에는|에도|이나|이랑|하고|에서|으로|은|는|이|가|도|만|과|와|에|을|를)?(?=$|[^가-힣A-Za-z])`).test(text);
}

/** 모델의 지역 요약을 믿지 않고 현재 수신 원문·명시적인 구직 문의/선호만 통과시킨다. */
export function validateRegionPreferences(raw: unknown, sources: ConsultationSourceMessage[]): RegionPreference[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const result: RegionPreference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { source_message_id, quote, regions } = item as Record<string, unknown>;
    const source = sources.find((entry) => entry.id === source_message_id);
    if (!source || typeof quote !== "string" || !quote.trim() || quote.length > 800 || !source.body.includes(quote) ||
      !Array.isArray(regions) || !regions.length || regions.length > 8) return null;
    // 잘린 인용문 바깥의 부정/타인 발언도 확인한다. 서로 다른 지역의 대조 절은 분리한다.
    const sentences = (source.body.match(/[^.!?？\n]+[.!?？]?/g) ?? [])
      .flatMap((sentence) => sentence.split(/(?<=싫고|않고|말고|대신|지만)\s*/));
    for (const region of regions) {
      if (typeof region !== "string" || !/^[가-힣A-Za-z][가-힣A-Za-z ·-]{1,39}$/.test(region) || region !== region.trim() ||
        /^(?:공고|일자리|일감|지역|근무|배송|차량|선호|희망)$/.test(region) || !includesRegion(quote, region)) return null;
      const evidence = sentences.filter((sentence) => includesRegion(sentence, region) && (sentence.includes(quote) || quote.includes(sentence.trim()) || quote.includes(sentence.trim().replace(/[.!?？]$/, ""))));
      if (evidence.length !== 1 || !(SEARCH_INTENT.test(evidence[0]) || REGIONAL_AVAILABILITY.test(evidence[0])) || NOT_OWN_PREFERENCE.test(evidence[0]) || NEGATIVE_PREFERENCE.test(evidence[0])) return null;
    }
    result.push({ source_message_id: source.id, quote, regions: [...new Set(regions as string[])] });
  }
  return result;
}

/** 지역 일치도는 등록 집결지 확인용일 뿐 출퇴근 가능성이나 채용 적합성 판정이 아니다. */
export function pickupMatchesRegions(pickupArea: string, regions: string[]): boolean {
  return regions.some((region) => includesRegion(pickupArea, region));
}

/** 단일 노출 공고에서도 지역 구직 문의를 상담 계약으로 보낸다. 지역 추출·기록은 별도 원문 검증을 거친다. */
export function likelyRegionInquiry(text: string): boolean {
  return (SEARCH_INTENT.test(text) || REGIONAL_AVAILABILITY.test(text)) && /(?:지역|쪽|근처|부근|방면)|[가-힣]{2,}(?:에서|은|는|이나|도)\s*(?:일자리|일감|공고|자리|일하고)|[가-힣]{2,}\s*(?:일자리|일감|공고)/.test(text);
}
