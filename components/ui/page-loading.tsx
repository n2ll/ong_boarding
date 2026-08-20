export function PageLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="w-full space-y-4 p-4 sm:p-6 lg:p-8">
      <span className="sr-only">{label}</span>
      <div className="h-10 w-56 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-24 animate-pulse rounded-2xl border border-border bg-card/70 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-card/70 motion-reduce:animate-none" />
    </div>
  );
}
