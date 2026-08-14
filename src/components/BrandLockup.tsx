interface BrandLockupProps {
  name: string;
}

export function BrandLockup({ name }: BrandLockupProps) {
  return (
    <div className="brand-lockup">
      <img
        className="brand-mark"
        src="/prompter.svg"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <strong>{name}</strong>
    </div>
  );
}
