import { manifestResponse } from "@/lib/pwa/route";

export function GET() {
  return manifestResponse("storefront");
}
