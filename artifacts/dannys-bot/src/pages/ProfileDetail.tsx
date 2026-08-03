import { useParams, Link } from "wouter";
import { ArrowLeft, Instagram, Loader2 } from "lucide-react";
import { useProfile } from "@/hooks/use-profiles";
import { ToolConfig } from "@/components/ToolConfig";
import { ApiLeakCheck } from "@/components/ApiLeakCheck";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

export default function ProfileDetail() {
  const { id } = useParams();
  const profileId = Number(id);
  const { data: profile, isLoading } = useProfile(profileId);

  if (isLoading) {
    return <div className="flex justify-center p-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  if (!profile) {
    return <div className="p-20 text-center text-lg text-slate-500">Profile not found.</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" asChild className="hover:bg-slate-200/50">
          <Link href="/profiles"><ArrowLeft className="h-5 w-5" /></Link>
        </Button>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-pink-500 to-orange-400 p-0.5">
            <div className="h-full w-full bg-white rounded-full flex items-center justify-center border-2 border-white">
              <Instagram className="h-5 w-5 text-slate-700" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">@{profile.username}</h1>
            <p className="text-sm text-muted-foreground">Automation Configuration</p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="follow" className="w-full">
        <TabsList className="h-auto w-full justify-start bg-white border border-slate-200 p-1 mb-8 rounded-xl flex-wrap shadow-sm">
          <TabsTrigger value="dashboard" disabled className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">Dashboard</TabsTrigger>
          <TabsTrigger value="follow" className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">Auto Follow</TabsTrigger>
          <TabsTrigger value="unfollow" className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">Auto Unfollow</TabsTrigger>
          <TabsTrigger value="like" className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">Auto Like</TabsTrigger>
          <TabsTrigger value="dm" className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">Direct Messages</TabsTrigger>
          <TabsTrigger value="api-leak" className="text-sm px-5 h-11 rounded-lg data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:font-semibold">API Checks</TabsTrigger>
        </TabsList>
        
        <TabsContent value="follow" className="m-0 focus-visible:outline-none">
          <ToolConfig profileId={profile.id} type="follow" />
        </TabsContent>
        <TabsContent value="unfollow" className="m-0 focus-visible:outline-none">
          <ToolConfig profileId={profile.id} type="unfollow" />
        </TabsContent>
        <TabsContent value="like" className="m-0 focus-visible:outline-none">
          <ToolConfig profileId={profile.id} type="like" />
        </TabsContent>
        <TabsContent value="dm" className="m-0 focus-visible:outline-none">
          <ToolConfig profileId={profile.id} type="dm" />
        </TabsContent>
        <TabsContent value="api-leak" className="m-0 focus-visible:outline-none">
          <ApiLeakCheck profileId={profile.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
