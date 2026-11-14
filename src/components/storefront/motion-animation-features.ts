import { domAnimation } from "motion/react";

// Loaded after hydration so the animation code is not on the path to the first paint (#563).
export default domAnimation;
