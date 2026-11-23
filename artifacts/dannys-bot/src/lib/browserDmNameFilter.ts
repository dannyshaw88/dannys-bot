/**
 * Name filter for the browser-based Send DMs tool.
 *
 * "Girls Only" is an exclusion rule: when enabled, reject a profile only if
 * one of its name tokens matches this built-in list. It does not require a
 * positive match against a girls' name list.
 */
const COMMON_MALE_NAMES = new Set(
  [
    "aaron", "abdul", "abdullah", "abraham", "adam", "adnan", "ahmad", "ahmed",
    "alan", "albert", "alexander", "ali", "amir", "andre", "andrew", "anthony",
    "antonio", "arjun", "arthur", "asif", "austin", "ayaan", "aziz", "bailey",
    "ben", "benjamin", "bilal", "blake", "bradley", "brandon", "brian", "bruce",
    "caleb", "cameron", "carl", "carlos", "charles", "charlie", "chris", "christian",
    "christopher", "cody", "colin", "connor", "craig", "daniel", "david", "dylan",
    "edward", "elijah", "elliot", "elliott", "emmanuel", "eric", "ethan", "eugene",
    "evan", "faisal", "farhan", "frank", "gabriel", "gary", "gavin", "george",
    "gerard", "gregory", "hamza", "hassan", "harry", "henry", "hugo", "ibrahim",
    "imran", "isaac", "ismail", "jack", "jacob", "jake", "james", "jared",
    "jason", "jeffrey", "jeremy", "jesse", "joe", "joel", "john", "jonathan",
    "jose", "joseph", "joshua", "juan", "justin", "kareem", "karl", "keith",
    "kenneth", "kevin", "khalid", "kyle", "lawrence", "leo", "liam", "logan",
    "louis", "lucas", "luke", "malik", "manuel", "marcus", "mark", "martin",
    "mason", "matthew", "michael", "miguel", "mohamed", "mohammad", "mohammed",
    "muhammad", "musa", "mustafa", "nathan", "nathaniel", "neil", "nicholas",
    "noah", "omar", "oliver", "oscar", "owen", "patrick", "paul", "peter",
    "philip", "rafael", "raymond", "richard", "robert", "ryan", "samuel", "scott",
    "sean", "sebastian", "sergio", "seth", "shane", "simon", "stephen", "steve",
    "steven", "stuart", "taha", "tariq", "thomas", "timothy", "tony", "tyler",
    "umar", "victor", "vincent", "wayne", "william", "wyatt", "xavier", "yusuf",
    "zachary", "zain", "zayn",
  ].map((name) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()),
);

/** Normalize punctuation, emoji, and diacritics into exact name-word tokens. */
export function getBrowserDmNameTokens(displayName: string): string[] {
  return (
    displayName
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/\p{L}+/gu) ?? []
  );
}

/** True when any complete name token matches a built-in common male name. */
export function hasCommonMaleName(displayName: string): boolean {
  return getBrowserDmNameTokens(displayName).some((token) => COMMON_MALE_NAMES.has(token));
}

/** Girls Only skips only male-name matches; all other names remain eligible. */
export function shouldSkipBrowserDmName(
  displayName: string,
  girlsOnlyEnabled: boolean,
): boolean {
  return girlsOnlyEnabled && hasCommonMaleName(displayName);
}
