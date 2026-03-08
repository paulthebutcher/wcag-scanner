export {
  checkPauseStopHide,
  checkThreeFlashes,
  detectCSSAnimations,
  detectCarousels,
  detectGIFs,
  detectVideos,
  findPauseMechanisms,
  type AnimatedElement,
  type AnimationType,
  type PauseMechanism,
} from "./pause-stop-hide.js";

export {
  checkMultipleWays,
  checkMotionActuation,
  detectNavigationMethods,
  detectNavMenu,
  detectSearch,
  detectSitemapLink,
  detectTableOfContents,
  detectBreadcrumbs,
  detectMotionListeners,
  type NavigationMethod,
  type NavigationType,
} from "./multiple-ways.js";

export {
  checkOnInput,
  surfaceErrorQualityFindings,
  evaluateErrorQuality,
  type InputStateChange,
  type StateChangeType,
} from "./on-input.js";
