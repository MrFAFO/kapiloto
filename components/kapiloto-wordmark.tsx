type KapilotoWordmarkProps = {
  size?: "header" | "hero";
  className?: string;
};

/** Official Brand/Kapiloto Wordmark (Figma component 69:20). */
export function KapilotoWordmark({
  size = "header",
  className = "",
}: KapilotoWordmarkProps) {
  const hero = size === "hero";

  return (
    <div
      className={`flex items-center justify-center p-1 ${hero ? "gap-2" : "gap-[5px]"} ${className}`}
      aria-label="קפילוטו"
    >
      <span
        aria-hidden
        className={`whitespace-nowrap bg-gradient-to-r from-[#fafaff] via-[#cca3ff] via-[58%] to-[#8c3dfa] bg-clip-text font-extrabold leading-none text-transparent [filter:drop-shadow(0_3px_8px_rgba(112,56,250,0.26))] ${hero ? "text-[42px]" : "text-[22px]"}`}
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
      >
        קפילוטו
      </span>
      <img
        src="/brand/kapiloto-football-mark.svg"
        alt=""
        width={hero ? 34 : 19}
        height={hero ? 34 : 19}
        className={`block shrink-0 ${hero ? "size-[34px]" : "size-[19px]"}`}
      />
    </div>
  );
}
