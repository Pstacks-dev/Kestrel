import { Download, Menu, Play } from 'lucide-react';
import { NavSection, PipelineRun } from '../types/pipeline';

interface HeaderProps {
  activeSection: NavSection;
  activeProjectName: string;
  activeRun: PipelineRun | undefined;
  onOpenMobileMenu: () => void;
  onTriggerRun: () => void;
  onExportLogs: () => void;
  isSimulating: boolean;
}

const SECTION_TITLES: Record<NavSection, string> = {
  pipelines: 'Pipelines',
  runs: 'Run History',
  cache: 'Artifact Cache',
  workers: 'Worker Nodes',
};

export function Header({
  activeSection,
  activeProjectName,
  activeRun,
  onOpenMobileMenu,
  onTriggerRun,
  onExportLogs,
  isSimulating,
}: HeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-[#E5E5E0] bg-white px-4 lg:px-6 shrink-0">
      {/* Left: Mobile drawer trigger + contextual breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden flex h-10 w-10 items-center justify-center rounded-md border border-[#E5E5E0] text-[#141413] hover:bg-[#F6F6F4] focus-visible:outline-2 focus-visible:outline-[#141413] shrink-0"
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" />
        </button>

        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-[#73736D] whitespace-nowrap shrink-0">
            {SECTION_TITLES[activeSection]}
          </span>
          {activeSection === 'pipelines' && (
            <>
              <span className="text-[#B8B8B0]" aria-hidden="true">
                /
              </span>
              <span className="text-[#52524D] truncate max-w-[140px] sm:max-w-none">
                {activeProjectName}
              </span>
              {activeRun && (
                <>
                  <span className="hidden sm:inline text-[#B8B8B0]" aria-hidden="true">
                    /
                  </span>
                  <span className="hidden sm:inline font-semibold text-[#141413] font-mono tabular-nums whitespace-nowrap shrink-0">
                    Run #{activeRun.runNumber}
                  </span>
                </>
              )}
            </>
          )}
        </nav>
      </div>

      {/* Right: Primary workflow actions */}
      <div className="flex items-center gap-2.5 shrink-0">
        {activeSection === 'pipelines' && activeRun && (
          <button
            type="button"
            onClick={onExportLogs}
            className="hidden sm:inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-[#141413] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#F6F6F4] transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#141413]"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Export Logs</span>
          </button>
        )}

        <button
          type="button"
          onClick={onTriggerRun}
          disabled={isSimulating}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[#141413] rounded-md hover:bg-[#2A2A28] disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#141413]"
        >
          <Play className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{isSimulating ? 'Running Pipeline...' : 'Trigger Pipeline'}</span>
        </button>
      </div>
    </header>
  );
}
