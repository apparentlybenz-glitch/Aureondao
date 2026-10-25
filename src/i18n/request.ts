import { getRequestConfig } from "next-intl/server";

// English only, no locale segment in URLs. Adding a locale later means
// adding messages/<locale>.json and choosing the locale here.
export default getRequestConfig(async () => {
  const locale = "en";
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
