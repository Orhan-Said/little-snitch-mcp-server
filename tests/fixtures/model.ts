import { parseModelText, type JsonObject } from '../../src/model/json.js';

/**
 * A made-up Little Snitch configuration in the shape `littlesnitch export-model`
 * prints. The shape follows what the torsday/little-snitch-mcp project recorded
 * from Little Snitch 6.3.3 (dates as text) and its issue reports about 6.5
 * (last-used times as numbers). No real person's rules are in here.
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
    "aaaaab": { "kind": "builtinMacOSServices", "name": null, "isActive": true },
    "aaaaac": { "kind": "builtinICloudServices", "name": null, "isActive": false },
    "aaaaad": { "kind": "local", "name": "Work rules", "isActive": true },
    "aaaaae": { "kind": "builtinSomethingNew", "name": null, "isActive": true }
  },
  "profiles": {
    "p1": { "name": "Home" },
    "p2": { "name": "Work", "silentMode": 1.0 }
  },
  "noProfilePseudoProfile": {},
  "globalDefaults": { "allowCommandLineAccess": true },
  "users": [
    { "uid": 501, "shortName": "tester", "fullName": "Test User", "defaults": { "activeProfile": "p2" } }
  ],
  "networkTriggers": [],
  "disabledDomainsInLists": []
}
`;
}

export function sampleModel(options: SampleOptions = {}): JsonObject {
  return parseModelText(sampleModelText(options));
}
