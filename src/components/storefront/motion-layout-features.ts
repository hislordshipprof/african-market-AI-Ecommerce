import { domMax } from "motion/react";

// Only result grids request projection. Hero/rails keep the smaller domAnimation bundle.
const layoutFeatures = { renderer: domMax.renderer, layout: domMax.layout };
export default layoutFeatures;
