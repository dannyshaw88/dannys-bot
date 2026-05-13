import { useState } from "react";
import { Link } from "wouter";
import { Plus, MoreVertical, Play, Square, Settings, Trash2, Instagram, Loader2 } from "lucide-react";
import { useProfiles, useCreateProfile, useDeleteProfile, useStartProfile, useStopProfile } from "@/hooks/use-profiles";
import { useProxies } from "@/hooks/use-proxies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export default function ProfilesList() {
  const { data: profiles, isLoading } = useProfiles();
  const { data: proxies } = useProxies();
  const createProfile = useCreateProfile();
  const deleteProfile = useDeleteProfile();
  const startProfile = useStartProfile();
  const stopProfile = useStopProfile();

  const [isOpen, setIsOpen] = useState(false);
  const [formData, setFormData] = useState({ username: "", password: "", proxyId: "" });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createProfile.mutate(
      { 
        username: formData.username, 
        password: formData.password, 
        proxyId: formData.proxyId ? Number(formData.proxyId) : null as any 
      },
      { 
        onSuccess: () => {
          setIsOpen(false);
          setFormData({ username: "", password: "", proxyId: "" });
        }
      }
    );
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Instagram Profiles</h1>
          <p className="text-muted-foreground mt-2">Manage your accounts and automation status.</p>
        </div>
        
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="h-11 px-6 shadow-lg shadow-primary/20 hover-elevate">
              <Plus className="h-5 w-5 mr-2" />
              Add Profile
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md bg-white border-slate-200">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold">Add Instagram Profile</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-5 pt-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input 
                  id="username" 
                  value={formData.username}
                  onChange={(e) => setFormData({...formData, username: e.target.value})}
                  placeholder="@username" 
                  className="h-11"
                  required 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                  id="password"
                  value={formData.password}
                  onChange={(e) => setFormData({...formData, password: e.target.value})}
                  className="h-11"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy">Assign Proxy (Optional)</Label>
                <Select value={formData.proxyId} onValueChange={(v) => setFormData({...formData, proxyId: v})}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Select a proxy..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Proxy (Direct)</SelectItem>
                    {proxies?.map(p => (
                      <SelectItem key={p.id} value={p.id.toString()}>{p.name} ({p.host})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full h-11 mt-2" disabled={createProfile.isPending}>
                {createProfile.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : "Connect Profile"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : profiles?.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-slate-200 shadow-sm">
          <Instagram className="h-16 w-16 text-slate-200 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-slate-700">No profiles found</h3>
          <p className="text-slate-500 mt-2 mb-6">Add your first Instagram account to start automating.</p>
          <Button onClick={() => setIsOpen(true)} variant="outline" className="border-slate-300">Add Profile</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {profiles?.map((profile) => (
            <div key={profile.id} className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-lg transition-all duration-300 flex flex-col">
              <div className="flex justify-between items-start mb-6">
                <div className="flex items-center gap-4">
                  <div className="h-14 w-14 rounded-full bg-gradient-to-tr from-pink-500 to-orange-400 p-0.5 shadow-md shrink-0">
                    <div className="h-full w-full bg-white rounded-full flex items-center justify-center border-2 border-white">
                      <span className="text-xl font-bold text-slate-700 select-none leading-none">
                        {(profile.username ?? "?")[0].toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-foreground">@{profile.username}</h3>
                    <div className="mt-1">
                      {profile.status === 'running' ? (
                        <Badge className="bg-green-100 text-green-700 hover:bg-green-200 font-medium">Running</Badge>
                      ) : profile.status === 'error' ? (
                        <Badge variant="destructive" className="font-medium">Error</Badge>
                      ) : (
                        <Badge variant="secondary" className="bg-slate-100 text-slate-600 font-medium">Idle</Badge>
                      )}
                    </div>
                  </div>
                </div>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="text-slate-400 hover:text-slate-700 -mr-2 -mt-2">
                      <MoreVertical className="h-5 w-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    {profile.status === 'running' ? (
                      <DropdownMenuItem onClick={() => stopProfile.mutate(profile.id)} className="text-orange-600 focus:text-orange-700">
                        <Square className="h-4 w-4 mr-2" /> Stop Automation
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => startProfile.mutate(profile.id)} className="text-green-600 focus:text-green-700">
                        <Play className="h-4 w-4 mr-2" /> Start Automation
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem asChild>
                      <Link href={`/profiles/${profile.id}`} className="cursor-pointer flex items-center">
                        <Settings className="h-4 w-4 mr-2" /> Manage Tools
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => deleteProfile.mutate(profile.id)}
                      className="text-red-600 focus:bg-red-50 focus:text-red-700"
                    >
                      <Trash2 className="h-4 w-4 mr-2" /> Delete Profile
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="mt-auto space-y-4 pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">Proxy</span>
                  <span className="font-medium text-slate-700">
                    {profile.proxyId ? proxies?.find(p => p.id === profile.proxyId)?.name || 'Unknown' : 'Direct (No Proxy)'}
                  </span>
                </div>
                <div className="flex gap-2">
                  {profile.status === 'running' ? (
                    <Button 
                      variant="outline" 
                      className="flex-1 border-orange-200 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                      onClick={() => stopProfile.mutate(profile.id)}
                      disabled={stopProfile.isPending}
                    >
                      {stopProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Stop"}
                    </Button>
                  ) : (
                    <Button 
                      variant="outline" 
                      className="flex-1 border-green-200 text-green-600 hover:bg-green-50 hover:text-green-700"
                      onClick={() => startProfile.mutate(profile.id)}
                      disabled={startProfile.isPending}
                    >
                      {startProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start"}
                    </Button>
                  )}
                  <Button asChild className="flex-1 bg-primary text-white hover:bg-primary/90">
                    <Link href={`/profiles/${profile.id}`}>Manage</Link>
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
