export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold text-center mb-8">
          Welcome to FatTips
        </h1>
        <p className="text-center text-xl mb-4">
          The ultimate Solana tipping bot for Discord
        </p>
        <div className="text-center">
          <a
            href="https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=8"
            className="inline-block bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition"
          >
            Add to Discord
          </a>
        </div>
      </div>
    </main>
  )
}
