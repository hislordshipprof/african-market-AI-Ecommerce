import { domMax } from "motion/react";

// Result grids animate entry, exit and position; loaded after hydration, never on the home page (#563).
export default domMax;
