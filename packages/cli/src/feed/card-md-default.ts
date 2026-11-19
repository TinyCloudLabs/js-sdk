/**
 * The card.md the Feed gives every agent until its owner changes it. The text is byte for byte the Feed's own default,
 * and card-md-default.test.ts pins its version, which the Feed pins too: change both together.
 */
export const CARD_MD_DEFAULT_VERSION = "ce089aab8391";

export const CARD_MD_DEFAULT = `# card.md

How cards are made for this Feed. Every agent that posts here reads this before its first card. The owner can change it at any time; when it changes, follow the new version.

## Writing a card

1. Plain words first. Write for the owner, not for another agent: no code names, file paths or ids in the text.
2. Start with a short post: what happened, in one or two sentences. Put it in \`payload.summary\`, and don't repeat the title.
3. When the owner has to do something, give numbered steps, one action per step.
4. When you ask for access, name the exact thing and the limit: which data or app, what you will do with it (read, or read and change), and for how long. Never ask for more than the task needs.
5. One card per thing. Don't edit a card to show progress: post a new update.
6. On every card, set \`payload.priority\` (0 is the most urgent, 5 is routine news) and \`payload.agent\`. When anything has a date, set \`payload.deadline\` and \`payload.expiresAt\`.

## Card kinds

- **Decision**: the owner picks one of two to four. The options go in \`choices\`, as \`{"id", "label"}\` (not \`options\`). Add \`payload.brief\` with the sections Background, Why now, If you don't answer, The options and Recommendation.
- **Update**: news that needs no answer. \`needsResponse\` is \`false\` and there are no \`choices\`. To point at a web page, set \`payload.render\` to \`link\` and add \`payload.url\`.
- **Page**: several questions at once, with something to look at. It needs both \`payload.page.image\` (a public \`https://\` image) and \`payload.page.questions\`. Without both, the Feed shows a plain card and none of your questions.

## What publishing checks

\`feed publish\` checks only the outer card. It never checks \`payload\`, and it drops any other top-level field without saying so: \`priority\` belongs in \`payload.priority\`. Copy the shapes below.

## Known-good cards

### Decision

\`\`\`json
{
  "cardId": "weight-goal-2026-11",
  "revision": 1,
  "issuanceId": "weight-goal-2026-11-r1",
  "kind": "decision",
  "needsResponse": true,
  "title": "New weekly goal?",
  "body": "You were under 82 kg all week. I suggest 81.5 kg for next week.",
  "choices": [
    {
      "id": "lower",
      "label": "81.5 kg"
    },
    {
      "id": "keep",
      "label": "Keep 82 kg"
    }
  ],
  "urgency": 2,
  "createdAt": "2026-11-03T09:00:00Z",
  "payload": {
    "render": "post",
    "priority": 3,
    "deadline": "2026-11-08T18:00:00Z",
    "expiresAt": "2026-11-09T00:00:00Z",
    "summary": "Lower next week's goal to 81.5 kg, or keep 82 kg?",
    "agent": {
      "kind": "claude",
      "model": "Claude Sonnet 5.5",
      "runsOn": "Home laptop",
      "job": "Weight tracker"
    },
    "brief": {
      "title": "Next week's weight goal",
      "markdown": "## Background\\nYour weekly goal this month is 82 kg. This week's weigh-ins: 81.9, 81.7, 81.6 and 81.4 kg.\\n\\n## Why now\\nI set next week's goal on Sunday evening.\\n\\n## If you don't answer\\nThe goal stays at 82 kg.\\n\\n## The options\\n| | 81.5 kg | Keep 82 kg |\\n|---|---|---|\\n| Change | 0.5 kg lower | None |\\n| Risk | A miss if the week goes badly | You stop making progress |\\n\\n## Recommendation\\n81.5 kg: you were under it on three of four days."
    }
  }
}
\`\`\`

### Update

\`\`\`json
{
  "cardId": "weight-2026-11-03",
  "revision": 1,
  "issuanceId": "weight-2026-11-03-r1",
  "kind": "update",
  "needsResponse": false,
  "title": "New low",
  "body": "81.4 kg this morning, 0.6 kg under your previous best.",
  "urgency": 0,
  "createdAt": "2026-11-03T07:42:10Z",
  "payload": {
    "render": "post",
    "priority": 5,
    "summary": "81.4 kg, a new low.",
    "agent": {
      "kind": "claude",
      "model": "Claude Sonnet 5.5",
      "runsOn": "Home laptop",
      "job": "Weight tracker"
    },
    "source": {
      "label": "Weigh-ins"
    }
  }
}
\`\`\`

### Update with a link

\`\`\`json
{
  "cardId": "weight-report-2026-11",
  "revision": 1,
  "issuanceId": "weight-report-2026-11-r1",
  "kind": "update",
  "needsResponse": false,
  "title": "October report",
  "body": "Your October weigh-ins in one chart: down 1.8 kg over the month.",
  "urgency": 1,
  "createdAt": "2026-11-01T08:00:00Z",
  "payload": {
    "render": "link",
    "url": "https://example.org/weight/october",
    "priority": 4,
    "summary": "October: down 1.8 kg. The chart is one tap away.",
    "agent": {
      "kind": "claude",
      "model": "Claude Sonnet 5.5",
      "runsOn": "Home laptop",
      "job": "Weight tracker"
    }
  }
}
\`\`\`

### Page

\`\`\`json
{
  "cardId": "party-plan-2026-11",
  "revision": 1,
  "issuanceId": "party-plan-2026-11-r1",
  "kind": "page",
  "needsResponse": true,
  "title": "Plan for Mia's party",
  "body": "I found the hall and two cakes. Three things to settle before I book.",
  "urgency": 3,
  "createdAt": "2026-11-03T10:00:00Z",
  "payload": {
    "render": "post",
    "priority": 2,
    "deadline": "2026-11-05T12:00:00Z",
    "summary": "Pick a date, cakes and anything else before I book the hall.",
    "agent": {
      "kind": "claude",
      "model": "Claude Sonnet 5.5",
      "runsOn": "Home laptop",
      "job": "Party planner"
    },
    "page": {
      "image": "https://example.org/hall.jpg",
      "imageAlt": "The hall set up for a party",
      "questions": [
        {
          "id": "date",
          "header": "Date",
          "question": "Which day?",
          "options": [
            {
              "label": "Saturday",
              "recommended": true,
              "description": "Hall free all day"
            },
            {
              "label": "Sunday"
            }
          ]
        },
        {
          "id": "cakes",
          "header": "Cakes",
          "question": "Which cakes should I order?",
          "multi": true,
          "options": [
            {
              "label": "Chocolate",
              "image": "https://example.org/choc.jpg"
            },
            {
              "label": "Lemon"
            }
          ],
          "notePrompt": "Any allergies?"
        },
        {
          "id": "else",
          "header": "Anything else",
          "question": "Anything else I should arrange?"
        }
      ]
    }
  }
}
\`\`\`

## The owner's preferences

None. The owner can add their own rules here.
`;
