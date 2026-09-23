import type { MetadataRoute } from "next";

/* Web app manifest — lets Android "Add to Home screen" show the pixel Friend
   icon, name and colors instead of a generic tile. iOS uses the apple-icon
   route + the appleWebApp metadata in layout.tsx. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Friend Smash",
    short_name: "Friend Smash",
    description: "A falling-block smasher starring your Rare Friend. Built for the Rare Friends Vibeathon.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#eeeeee",
    theme_color: "#111111",
    icons: [{ src: "/apple-icon", sizes: "180x180", type: "image/png" }],
  };
}
