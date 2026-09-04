# Videofy Live Operator — Premium UI Implementation Contract

These PNGs are visual acceptance references, not inspiration.

## Non-regression rule

Do not rewrite working operator-domain logic merely to achieve the redesign. Existing state, controllers, socket events, media managers, authentication boundaries, and server contracts remain authoritative. Presentation components consume them through props/adapters.

## Visual acceptance

Primary desktop reference viewport: 1586 × 992 CSS pixels at 100% zoom.

For every implemented reference page:
1. Capture the rendered page at the reference viewport.
2. Compare against the corresponding PNG with an automated perceptual/pixel diff.
3. Audit geometry, typography, spacing, card sizes, border radii, gradients, shadows, icons, states, and responsive behavior.
4. Repeat until the perceptual result is effectively indistinguishable at normal viewing distance. Do not declare completion from subjective inspection alone.

The mockups contain sample state values. Never hard-code sample data solely to make the screenshot match. Values and statuses must come from real application state; unavailable capability should render an honest unavailable/waiting state.

## Functional acceptance

Every interactive element must be classified before implementation:
- REAL: backed by an existing application/server contract. Preserve and connect it.
- PARTIAL: some contract exists but the end-to-end behavior is incomplete. Complete it or render an honest disabled/partial state.
- FUTURE: no backend/domain contract exists. Do not create a fake working control. Hide or render explicitly unavailable until its owning work is authorized.

No button may be enabled unless its action is real. No status value may be invented.

## Page-specific constraints

### Overview
Keep live status driven by gateway/media/programme state. The visual pipeline is decorative/navigation only; it must not invent readiness.

### Source
Preserve the existing real source manager/controller flows for upload, camera/capture, screen, OBS virtual camera, direct URL and RTMP. The preview must remain the actual programme preview element. Do not replace it with decorative canvas/video.

### Languages
No EN→ES preset. Source is Auto-detect or manual. Targets are explicit operator multi-select. The catalogue must be available before a programme starts through a real capability-catalogue read, rather than waiting for a processing session/media-state event.

### Audio & Voices
Original/translated volume controls and mode/subtitle controls must drive real listener output. Voice rows may show real registry/capability state only. No fake per-programme voice picker before its backend contract exists.

### Live Control
Start/pause/resume/restart/end/record remain real controls. Transcript, translation and generated voice cards consume real events. Technical diagnostics stay collapsed. Do not hard-code example "Good" quality or "480 ms" delay: programme-quality/runway metrics appear only when the real quality engine owns them.

## Placeholder pages in current code
Programme Vocabulary, Quality / Delay, and Advertising are currently NotYetPage placeholders. A premium skin does not make them functional. Keep them explicitly unavailable until their domain/backend slices exist, or implement the authorized backend slice before exposing active controls.

## Definition of done
A page is complete only when both are true:
- VISUAL PASS against its fixed PNG reference.
- FUNCTIONAL PASS against its interaction/state contract with no regression.
