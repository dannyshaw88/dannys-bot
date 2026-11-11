export interface SimCountry {
  code: string;
  name: string;
  providers: string[];
}

// ISO 3166-1 country/territory flags plus the commonly used Kosovo, EU,
// United Nations, Clipperton Island, Diego Garcia, and Canary Islands flags.
const COUNTRY_CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CP CR CU CV CW CX CY CZ
DE DG DJ DK DM DO DZ
EC EE EG EH ER ES ET EU
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
IC ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM UN US UY UZ
VA VC VE VG VI VN VU
WF WS
XK
YE YT
ZA ZM ZW
`.trim().split(/\s+/);

const PROVIDERS_BY_COUNTRY: Record<string, string[]> = {
  GB: ["EE", "O2", "Three", "Vodafone", "giffgaff", "Tesco Mobile", "iD Mobile", "VOXI", "Smarty"],
  US: ["AT&T", "T-Mobile", "Verizon", "UScellular", "Visible", "Mint Mobile", "Cricket"],
  CA: ["Bell", "Rogers", "TELUS", "Freedom Mobile", "Fido", "Koodo", "Virgin Plus"],
  AU: ["Telstra", "Optus", "Vodafone", "amaysim", "Boost Mobile", "Belong"],
  DE: ["Telekom", "Vodafone", "O2", "1&1", "Aldi Talk", "Congstar"],
  FR: ["Orange", "SFR", "Bouygues Telecom", "Free Mobile", "Lebara", "NRJ Mobile"],
  ES: ["Movistar", "Vodafone", "Orange", "Yoigo", "MásMóvil", "Digi"],
  IT: ["TIM", "Vodafone", "WindTre", "Iliad", "Fastweb", "ho. Mobile"],
  IN: ["Jio", "Airtel", "Vi", "BSNL", "MTNL"],
  NL: ["KPN", "Vodafone", "Odido", "Lebara", "Simyo", "Youfone"],
  IE: ["Three", "Vodafone", "eir", "Tesco Mobile", "GoMo"],
  ZA: ["Vodacom", "MTN", "Cell C", "Telkom", "Rain"],
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export const SIM_COUNTRIES: SimCountry[] = COUNTRY_CODES
  .map(code => ({
    code,
    name: regionNames.of(code) ?? code,
    providers: PROVIDERS_BY_COUNTRY[code] ?? [],
  }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

export function getSimCountry(code: string | undefined): SimCountry {
  return SIM_COUNTRIES.find(country => country.code === code)
    ?? SIM_COUNTRIES.find(country => country.code === "GB")
    ?? SIM_COUNTRIES[0];
}
