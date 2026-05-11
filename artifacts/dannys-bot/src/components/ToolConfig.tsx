import { useState, useEffect } from "react";
import { Loader2, Settings2, Save } from "lucide-react";
import { useTools, useUpdateTool } from "@/hooks/use-tools";
import { SourcesList } from "./SourcesList";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface ToolConfigProps {
  profileId: number;
  type: string;
}

export function ToolConfig({ profileId, type }: ToolConfigProps) {
  const { data: tools, isLoading } = useTools(profileId);
  const updateTool = useUpdateTool();
  const { toast } = useToast();

  const tool = tools?.find(t => t.type === type);
  
  const [settings, setSettings] = useState({ delayMin: 30, delayMax: 60, maxPerDay: 100 });

  useEffect(() => {
    if (tool?.settings) {
      setSettings(tool.settings as any);
    }
  }, [tool]);

  if (isLoading) {
    return <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  if (!tool) {
    return (
      <div className="p-12 text-center bg-white rounded-xl border border-slate-200">
        <Settings2 className="h-12 w-12 text-slate-300 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-foreground">Tool Not Found</h3>
        <p className="text-muted-foreground mt-2">This tool is not provisioned for this profile.</p>
      </div>
    );
  }

  const handleSaveSettings = () => {
    updateTool.mutate(
      { id: tool.id, profileId, settings },
      { 
        onSuccess: () => toast({ title: "Settings saved successfully", variant: "default" }) 
      }
    );
  };

  const handleToggle = (enabled: boolean) => {
    updateTool.mutate(
      { id: tool.id, profileId, enabled },
      {
        onSuccess: () => toast({ 
          title: `Tool ${enabled ? 'enabled' : 'disabled'}`, 
          description: `Automation will ${enabled ? 'start' : 'stop'} running.` 
        })
      }
    );
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header & Status */}
      <div className="flex items-center justify-between bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-foreground capitalize">{type} Automation</h2>
          <p className="text-sm text-muted-foreground mt-1">Configure parameters and sources for this tool.</p>
        </div>
        <div className="flex items-center gap-4 bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">
          <Label htmlFor="tool-enabled" className="text-sm font-semibold text-slate-700">
            {tool.enabled ? "Active" : "Paused"}
          </Label>
          <Switch 
            id="tool-enabled" 
            checked={tool.enabled} 
            onCheckedChange={handleToggle}
            disabled={updateTool.isPending}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Settings Panel */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm h-fit">
          <div className="flex items-center gap-2 mb-6">
            <Settings2 className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">Parameters</h3>
          </div>
          
          <div className="space-y-5">
            <div className="space-y-3">
              <Label className="text-slate-600">Delay between actions (seconds)</Label>
              <div className="flex items-center gap-3">
                <Input 
                  type="number" 
                  value={settings.delayMin} 
                  onChange={(e) => setSettings({...settings, delayMin: Number(e.target.value)})}
                  className="bg-slate-50 border-slate-200 focus:ring-primary/20"
                />
                <span className="text-muted-foreground text-sm">to</span>
                <Input 
                  type="number" 
                  value={settings.delayMax} 
                  onChange={(e) => setSettings({...settings, delayMax: Number(e.target.value)})}
                  className="bg-slate-50 border-slate-200 focus:ring-primary/20"
                />
              </div>
            </div>
            
            <div className="space-y-3">
              <Label className="text-slate-600">Maximum actions per day</Label>
              <Input 
                type="number" 
                value={settings.maxPerDay} 
                onChange={(e) => setSettings({...settings, maxPerDay: Number(e.target.value)})}
                className="bg-slate-50 border-slate-200 focus:ring-primary/20"
              />
            </div>

            <Button 
              className="w-full mt-4 h-11 hover-elevate shadow-md shadow-primary/10" 
              onClick={handleSaveSettings}
              disabled={updateTool.isPending}
            >
              {updateTool.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Save Configuration
            </Button>
          </div>
        </div>

        {/* Sources Panel */}
        <div className="lg:col-span-2">
          <SourcesList toolId={tool.id} />
        </div>
      </div>
    </div>
  );
}
