/**
 * 주소 → 좌표 지오코딩
 * 1순위: NCloud Maps Geocoding (정확도↑, quota 200만/일)
 * 2순위: 카카오 로컬 API (현재 OPEN_MAP_AND_LOCAL 비활성)
 *
 * 함수명은 호환성을 위해 geocodeAddress 그대로 유지.
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  sido?: string;
  sigungu?: string;
  bname?: string;
  road_address?: string;
}

interface NCloudAddressElement {
  types?: string[];
  longName?: string;
  shortName?: string;
}

interface NCloudAddress {
  x: string; // lng
  y: string; // lat
  jibunAddress?: string;
  roadAddress?: string;
  addressElements?: NCloudAddressElement[];
}

interface KakaoDocument {
  x: string;
  y: string;
  address?: {
    region_1depth_name?: string;
    region_2depth_name?: string;
    region_3depth_name?: string;
  };
  road_address?: { address_name?: string };
}

function elementByType(
  elements: NCloudAddressElement[] | undefined,
  type: string
): string | undefined {
  return elements?.find((e) => e.types?.includes(type))?.longName;
}

async function geocodeNCloud(query: string): Promise<GeocodeResult | null> {
  const keyId = process.env.NAVER_NCLOUD_KEY_ID;
  const keySecret = process.env.NAVER_NCLOUD_KEY_SECRET;
  if (!keyId || !keySecret) return null;

  const url =
    "https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: {
      "x-ncp-apigw-api-key-id": keyId,
      "x-ncp-apigw-api-key": keySecret,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    console.error("[geocode ncloud HTTP]", res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as { addresses?: NCloudAddress[]; status?: string };
  const addr = json.addresses?.[0];
  if (!addr) return null;

  const lat = parseFloat(addr.y);
  const lng = parseFloat(addr.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    sido: elementByType(addr.addressElements, "SIDO"),
    sigungu: elementByType(addr.addressElements, "SIGUGUN"),
    bname:
      elementByType(addr.addressElements, "DONGMYUN") ||
      elementByType(addr.addressElements, "RI"),
    road_address: addr.roadAddress || addr.jibunAddress,
  };
}

async function geocodeKakao(query: string): Promise<GeocodeResult | null> {
  const apiKey = process.env.KAKAO_REST_API_KEY;
  if (!apiKey) return null;

  const url =
    "https://dapi.kakao.com/v2/local/search/address.json?query=" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { documents?: KakaoDocument[] };
  const doc = json.documents?.[0];
  if (!doc) return null;

  const lat = parseFloat(doc.y);
  const lng = parseFloat(doc.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const a = doc.address;
  return {
    lat,
    lng,
    sido: a?.region_1depth_name,
    sigungu: a?.region_2depth_name,
    bname: a?.region_3depth_name,
    road_address: doc.road_address?.address_name,
  };
}

interface OSMResult {
  lat: string;
  lon: string;
  display_name?: string;
  address?: {
    state?: string;
    province?: string;
    region?: string;
    city?: string;
    county?: string;
    borough?: string;
    suburb?: string;
    neighbourhood?: string;
    quarter?: string;
    road?: string;
  };
}

async function geocodeOSM(query: string): Promise<GeocodeResult | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&accept-language=ko&limit=1&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { "User-Agent": "ongoing-recruitment/1.0 (info@naeyil.com)" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as OSMResult[];
  const r = json[0];
  if (!r) return null;
  const lat = parseFloat(r.lat);
  const lng = parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const a = r.address;
  return {
    lat,
    lng,
    sido: a?.state || a?.province || a?.region,
    sigungu: a?.city || a?.county || a?.borough,
    bname: a?.suburb || a?.neighbourhood || a?.quarter,
    road_address: a?.road || r.display_name,
  };
}

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const trimmed = query?.trim();
  if (!trimmed) return null;
  try {
    // 1순위: NCloud (Maps 구독 시 동작), 2순위: Kakao (LOCAL 활성 시), 3순위: OSM
    const ncloud = await geocodeNCloud(trimmed);
    if (ncloud) return ncloud;
    const kakao = await geocodeKakao(trimmed);
    if (kakao) return kakao;
    return await geocodeOSM(trimmed);
  } catch (err) {
    console.error("[geocode] exception", err);
    return null;
  }
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
