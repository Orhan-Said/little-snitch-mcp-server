import { parseModelText, type JsonObject } from '../../src/model/json.js';

/**
 * A made-up Little Snitch configuration in the shape `littlesnitch export-model`
 * prints. The top-level sections, the rule fields, the rule groups ("type",
 * "userProvidedName") and the preference keys follow a real Little Snitch 6.5
 * configuration, of which only key names and value types were recorded
 * (2026-11-23). The rule origin "frontend" and the profiles follow what the
 * torsday/little-snitch-mcp project recorded from 6.3.3: that configuration
 * had no rule made in the app's own window and no profile. No real person's
 * rules are in here.
 */
export const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
export const SLACK = '/Applications/Slack.app/Contents/MacOS/Slack';
export const CURL = '/usr/bin/curl';

export interface SampleOptions {
  /** How rule dates are written. */
  readonly dates?: 'iso' | 'cocoa';
}

export function sampleModelText(options: SampleOptions = {}): string {
  const cocoa = options.dates === 'cocoa';
  const created = (iso: string, seconds: number): string => (cocoa ? String(seconds) : JSON.stringify(iso));
  return `{
  "bundleVersion": 6500,
  "factoryRuleSetVersion": 12,
  "rules": [
    {
      "action": "allow",
      "creationDate": ${created('2026-01-10T09:00:00Z', 789728400)},
      "modificationDate": ${created('2026-01-10T09:00:00Z', 789728400)},
      "origin": "frontend",
      "uid": 501,
      "process": "${SAFARI}",
      "remote-domains": "example.com",
      "lastUsed": 816000000.5,
      "useCount": 42
    },
    {
      "action": "deny",
      "creationDate": ${created('2026-02-01T12:30:00Z', 791641800)},
      "modificationDate": ${created('2026-03-05T08:00:00Z', 794390400)},
      "origin": "frontend",
      "uid": 501,
      "process": "${SLACK}",
      "remote-hosts": ["telemetry.slack.example", "metrics.slack.example"],
      "notes": "no telemetry",
      "group": "aaaaad"
    },
    {
      "action": "allow",
      "origin": "factory",
      "factoryID": "macos.mdns",
      "protected": true,
      "process": "any",
      "remote": "bonjour",
      "group": "aaaaab"
    },
    {
      "action": "allow",
      "creationDate": ${created('2025-06-01T00:00:00Z', 770428800)},
      "modificationDate": ${created('2025-06-01T00:00:00Z', 770428800)},
      "origin": "frontend",
      "uid": 501,
      "process": "${CURL}",
      "remote": "any",
      "ports": "443",
      "protocol": "6",
      "priority": "high",
      "lastUsed": 780000000,
      "useCount": 3,
      "futureFlag": 18446744073709551615
    }
  ],
  "groups": {
    "aaaaab": { "type": "builtinMacOSServices", "isActive": true, "updateInterval": 86400, "lastUpdateInvalidDomainsCount": 0 },
    "aaaaac": { "type": "builtinICloudServices", "isActive": false, "updateInterval": 86400, "lastUpdateInvalidDomainsCount": 0 },
    "aaaaad": { "type": "loadedFromFile", "userProvidedName": "Work rules", "isActive": true, "updateInterval": 86400, "lastUpdateInvalidDomainsCount": 0 },
    "aaaaae": { "type": "builtinSomethingNew", "isActive": true, "updateInterval": 86400, "lastUpdateInvalidDomainsCount": 0 }
  },
  "profiles": {
    "p1": { "name": "Home" },
    "p2": { "name": "Work", "silentMode": 1.0 }
  },
  "noProfilePseudoProfile": { "name": "Effective in all profiles" },
  "globalDefaults": { "allowCommandLineAccess": true, "networkFilterEnabled": true, "activeSilentMode": 0, "ipAddressDatabaseLastUpdateCheck": 816000000 },
  "users": [
    { "uid": 501, "shortName": "tester", "fullName": "Test User", "defaults": { "activeProfile": "p2", "allowRuleAndProfileEditing": true, "allowProfileSwitching": true, "markNewRulesAsUnapproved": false, "pidOfLSCShowingWelcomeWindow": 0, "GeoViewMyLocationLatitude": 40.4, "GeoViewMyLocationLongitude": 49.8 } }
  ],
  "networkTriggers": [],
  "disabledDomainsInLists": [],
  "knownNEs": [],
  "codeRequirements": {},
  "developerTeamNames": {},
  "lastSeenExecutableByCodeIdentifier": { "MLZF7K7B5R/at.obdev.littlesnitch": "/Applications/Little Snitch.app" },
  "blocklistStatistics": {},
  "statisticsModelCreationDate": 780000000
}
`;
}

export function sampleModel(options: SampleOptions = {}): JsonObject {
  return parseModelText(sampleModelText(options));
}
