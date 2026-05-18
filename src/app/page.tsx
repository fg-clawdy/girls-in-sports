export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center py-32 px-16">
        <h1 className="text-3xl font-semibold tracking-tight text-black mb-4">
          Girls In Sports
        </h1>
        <p className="text-lg text-zinc-600 text-center">
          Media Catalog &amp; AI Marketing Composer
        </p>
        <p className="text-sm text-zinc-400 mt-8">
          App running on port 3010
        </p>
      </main>
    </div>
  );
}
