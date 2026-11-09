"use client";

import { useSearchParams } from "next/navigation";

// One query parameter, kept up to date on client-side navigation. (Reading
// window.location while the screen mounts gave the previous page's URL when a link
// like /trade?league=7 was followed from inside the app.) Pages using it wrap the
// screen in <Suspense>, which Next.js needs for useSearchParams.
export function useQueryParam(name: string): string | null {
  return useSearchParams().get(name);
}
