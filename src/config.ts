export type Domain = "amazon.co.uk" | "amazon.com" | "amazon.de";

export interface DomainConfig {
  domain: Domain;
  alexaBase: string;
  /** App API host (eu-api or na-api); all supported regions use the modern app API. */
  appApiBase: string;
  locale: string;
  cookieSuffix: string;
}

export interface AlexaCliConfig {
  refreshToken: string;
  domain: Domain;
}

const CONFIGS: Record<Domain, DomainConfig> = {
  "amazon.co.uk": {
    domain: "amazon.co.uk",
    alexaBase: "https://alexa.amazon.co.uk",
    appApiBase: "https://eu-api-alexa.amazon.co.uk",
    locale: "en-GB",
    cookieSuffix: "acbuk",
  },
  "amazon.com": {
    domain: "amazon.com",
    alexaBase: "https://alexa.amazon.com",
    appApiBase: "https://na-api-alexa.amazon.com",
    locale: "en-US",
    cookieSuffix: "acb",
  },
  "amazon.de": {
    domain: "amazon.de",
    alexaBase: "https://alexa.amazon.de",
    appApiBase: "https://eu-api-alexa.amazon.de",
    locale: "de-DE",
    cookieSuffix: "acbde",
  },
};

export function getConfig(domain: Domain = "amazon.co.uk"): DomainConfig {
  return CONFIGS[domain];
}
