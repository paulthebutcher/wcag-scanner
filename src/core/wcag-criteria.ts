// ---------------------------------------------------------------------------
// The 50 WCAG 2.1 Level A and AA success criteria: the scan's scope. Every
// scan stores one CriterionResult per entry (P2-032, stored-criteria gap);
// the report's scorecard and executive summary count over this list.
// ---------------------------------------------------------------------------

export interface WcagCriterion {
  id: string;
  name: string;
  level: "A" | "AA";
}

export const WCAG_AA_CRITERIA: readonly WcagCriterion[] = [
  { id: "1.1.1", name: "Non-text Content", level: "A" },
  { id: "1.2.1", name: "Audio-only and Video-only (Prerecorded)", level: "A" },
  { id: "1.2.2", name: "Captions (Prerecorded)", level: "A" },
  { id: "1.2.3", name: "Audio Description or Media Alternative (Prerecorded)", level: "A" },
  { id: "1.2.4", name: "Captions (Live)", level: "AA" },
  { id: "1.2.5", name: "Audio Description (Prerecorded)", level: "AA" },
  { id: "1.3.1", name: "Info and Relationships", level: "A" },
  { id: "1.3.2", name: "Meaningful Sequence", level: "A" },
  { id: "1.3.3", name: "Sensory Characteristics", level: "A" },
  { id: "1.3.4", name: "Orientation", level: "AA" },
  { id: "1.3.5", name: "Identify Input Purpose", level: "AA" },
  { id: "1.4.1", name: "Use of Color", level: "A" },
  { id: "1.4.2", name: "Audio Control", level: "A" },
  { id: "1.4.3", name: "Contrast (Minimum)", level: "AA" },
  { id: "1.4.4", name: "Resize Text", level: "AA" },
  { id: "1.4.5", name: "Images of Text", level: "AA" },
  { id: "1.4.10", name: "Reflow", level: "AA" },
  { id: "1.4.11", name: "Non-text Contrast", level: "AA" },
  { id: "1.4.12", name: "Text Spacing", level: "AA" },
  { id: "1.4.13", name: "Content on Hover or Focus", level: "AA" },
  { id: "2.1.1", name: "Keyboard", level: "A" },
  { id: "2.1.2", name: "No Keyboard Trap", level: "A" },
  { id: "2.1.4", name: "Character Key Shortcuts", level: "A" },
  { id: "2.2.1", name: "Timing Adjustable", level: "A" },
  { id: "2.2.2", name: "Pause, Stop, Hide", level: "A" },
  { id: "2.3.1", name: "Three Flashes or Below Threshold", level: "A" },
  { id: "2.4.1", name: "Bypass Blocks", level: "A" },
  { id: "2.4.2", name: "Page Titled", level: "A" },
  { id: "2.4.3", name: "Focus Order", level: "A" },
  { id: "2.4.4", name: "Link Purpose (In Context)", level: "A" },
  { id: "2.4.5", name: "Multiple Ways", level: "AA" },
  { id: "2.4.6", name: "Headings and Labels", level: "AA" },
  { id: "2.4.7", name: "Focus Visible", level: "AA" },
  { id: "2.5.1", name: "Pointer Gestures", level: "A" },
  { id: "2.5.2", name: "Pointer Cancellation", level: "A" },
  { id: "2.5.3", name: "Label in Name", level: "A" },
  { id: "2.5.4", name: "Motion Actuation", level: "A" },
  { id: "3.1.1", name: "Language of Page", level: "A" },
  { id: "3.1.2", name: "Language of Parts", level: "AA" },
  { id: "3.2.1", name: "On Focus", level: "A" },
  { id: "3.2.2", name: "On Input", level: "A" },
  { id: "3.2.3", name: "Consistent Navigation", level: "AA" },
  { id: "3.2.4", name: "Consistent Identification", level: "AA" },
  { id: "3.3.1", name: "Error Identification", level: "A" },
  { id: "3.3.2", name: "Labels or Instructions", level: "A" },
  { id: "3.3.3", name: "Error Suggestion", level: "AA" },
  { id: "3.3.4", name: "Error Prevention (Legal, Financial, Data)", level: "AA" },
  { id: "4.1.1", name: "Parsing", level: "A" },
  { id: "4.1.2", name: "Name, Role, Value", level: "A" },
  { id: "4.1.3", name: "Status Messages", level: "AA" },
];

export const WCAG_AA_CRITERION_IDS: readonly string[] = WCAG_AA_CRITERIA.map((c) => c.id);

const NAMES = new Map(WCAG_AA_CRITERIA.map((c) => [c.id, c.name]));

export function criterionName(id: string): string {
  return NAMES.get(id) ?? id;
}

export function isAaCriterion(id: string): boolean {
  return NAMES.has(id);
}
