const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";
const ODDS_BASE = "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb";

export interface EspnGame {
  id: string;
  awayAbbrev: string;
  awayName: string;
  homeAbbrev: string;
  homeName: string;
  awayRecord: string;
  homeRecord: string;
  awayML: number;
  homeML: number;
  overUnder: number;
  status: "scheduled" | "live" | "final";
  awayPitcher?: string;
  homePitcher?: string;
}

export interface EspnOdds {
  awayML: number;
  homeML: number;
  overUnder: number;
  provider: string;
  awayMLOpen: number | null;
  homeMLOpen: number | null;
}

// NOTE: Do NOT set a custom User-Agent header here. ESPN's edge (Akamai)
// fingerprint-checks the UA against the HTTP client and returns 403 Access
// Denied for any custom value (e.g. "Mozilla/5.0 (compatible; MLBBot/1.0)").
// The runtime's default UA is allowed.
async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    next: { revalidate: 300 },
  });
  if (!resp.ok) throw new Error(`ESPN API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function fetchScoreboard(date?: string): Promise<EspnGame[]> {
  // ESPN's default scoreboard uses the US-Eastern calendar day, which can lag
  // behind other timezones. Pass the date explicitly (YYYY-MM-DD) when known
  // so we always get the correct slate.
  const url = date
    ? `${SCOREBOARD_URL}?dates=${date.replace(/-/g, "")}`
    : SCOREBOARD_URL;
  const data = await fetchJson(url);
  const games: EspnGame[] = [];

  for (const event of data.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors = comp.competitors || [];
    const away = competitors.find((c: any) => c.homeAway === "away");
    const home = competitors.find((c: any) => c.homeAway === "home");
    if (!away || !home) continue;

    // Skip games that are already over (Final, Postponed, etc.)
    const state = event.status?.type?.state || "";
    if (state === "post") continue;

    games.push({
      id: comp.id,
      awayAbbrev: away.team.abbreviation,
      awayName: away.team.shortDisplayName || away.team.displayName,
      homeAbbrev: home.team.abbreviation,
      homeName: home.team.shortDisplayName || home.team.displayName,
      awayRecord: away.records?.[0]?.summary || "",
      homeRecord: home.records?.[0]?.summary || "",
      awayML: 0,
      homeML: 0,
      overUnder: 0,
      status: state === "in" ? "live" : "scheduled",
      awayPitcher: "",  // Populated from MLB schedule API in analysis route
      homePitcher: "",
    });
  }

  return games;
}

function parseAmericanLine(line: any): number | null {
  // The odds API gives opening/current lines as an object like
  // { american: "-150" } or { alternateDisplayValue: "-150" }.
  if (!line) return null;
  const raw = line.american ?? line.alternateDisplayValue ?? null;
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

export async function fetchGameOdds(eventId: string): Promise<EspnOdds | null> {
  try {
    const url = `${ODDS_BASE}/events/${eventId}/competitions/${eventId}/odds`;
    const data = await fetchJson(url);
    const item = data.items?.[0];
    if (!item) return null;

    return {
      awayML: item.awayTeamOdds?.moneyLine ?? 0,
      homeML: item.homeTeamOdds?.moneyLine ?? 0,
      overUnder: item.overUnder ?? 0,
      provider: item.provider?.name || "DraftKings",
      awayMLOpen: parseAmericanLine(item.awayTeamOdds?.open?.moneyLine),
      homeMLOpen: parseAmericanLine(item.homeTeamOdds?.open?.moneyLine),
    };
  } catch {
    return null;
  }
}

// Team abbreviation mapping for ESPN -> MLB API
// (inherited from the scraper)
export const TEAM_MAP: Record<string, string> = {
  "ARI": "Diamondbacks", "ATL": "Braves", "BAL": "Orioles", "BOS": "Red Sox",
  "CHC": "Cubs", "CHW": "White Sox", "CIN": "Reds", "CLE": "Guardians",
  "COL": "Rockies", "DET": "Tigers", "HOU": "Astros", "KC": "Royals",
  "LAA": "Angels", "LAD": "Dodgers", "MIA": "Marlins", "MIL": "Brewers",
  "MIN": "Twins", "NYM": "Mets", "NYY": "Yankees", "OAK": "Athletics",
  "PHI": "Phillies", "PIT": "Pirates", "SD": "Padres", "SF": "Giants",
  "SEA": "Mariners", "STL": "Cardinals", "TB": "Rays", "TEX": "Rangers",
  "TOR": "Blue Jays", "WSH": "Nationals",
};
