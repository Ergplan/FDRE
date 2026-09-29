/** Joulewise brand lockup used on every page. */
export default function Brand({ size = "md", product = true, className = "" }) {
  return (
    <span className={`jw-brand jw-${size} ${className}`}>
      <img src="/brand/joulewise-logo-dark.png" alt="Joulewise" width={981} height={230} />
      {product && <small>FDRE · Hybrid RE optimization</small>}
    </span>
  );
}
