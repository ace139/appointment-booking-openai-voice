import VoiceAgent from "./components/VoiceAgent";

export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
      <div className="container mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-4">
            Realtime Voice Agent Demo
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Experience real-time voice conversation with AI using OpenAI's Realtime API and WebRTC
          </p>
        </div>
        
        <VoiceAgent />
        
        <div className="mt-12 text-center text-gray-500">
          <p className="text-sm">
            Powered by OpenAI Realtime API • Built with Next.js 14 & TypeScript
          </p>
        </div>
      </div>
    </main>
  );
}