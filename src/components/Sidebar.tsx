import {
  Activity,
  Database,
  FolderGit2,
  History,
  Server,
  X,
} from 'lucide-react';
import { NavSection, PipelineProject } from '../types/pipeline';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  projects: PipelineProject[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  runningJobCount: number;
}

const NAV_ITEMS: { id: NavSection; label: string; icon: typeof Activity }[] = [
  { id: 'pipelines', label: 'Pipelines', icon: Activity },
  { id: 'runs', label: 'Run History', icon: History },
  { id: 'cache', label: 'Artifact Cache', icon: Database },
  { id: 'workers', label: 'Worker Nodes', icon: Server },
];

export function Sidebar({
  activeSection,
  onSelectSection,
  projects,
  activeProjectId,
  onSelectProject,
  mobileOpen,
  onCloseMobile,
  runningJobCount,
}: SidebarProps) {
  const handleNavClick = (section: NavSection) => {
    onSelectSection(section);
    onCloseMobile();
  };

  const handleProjectClick = (projectId: string) => {
    onSelectProject(projectId);
    onSelectSection('pipelines');
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-[#FAFAFA] border-r border-[#E5E5E0] select-none">
      {/* Brand header */}
      <div className="flex h-14 items-center justify-between px-5 border-b border-[#E5E5E0] shrink-0">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            handleNavClick('pipelines');
          }}
          className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[#141413] whitespace-nowrap shrink-0"
        >
          <span
            className="flex h-6 w-6 items-center justify-center border border-[#141413] bg-[#141413] text-white text-xs font-mono"
            aria-hidden="true"
          >
            K
          </span>
          <span>Kestrel</span>
        </a>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden flex h-9 w-9 items-center justify-center rounded-md text-[#52524D] hover:bg-[#EFEFEA] hover:text-[#141413] focus-visible:outline-2 focus-visible:outline-[#141413]"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable navigation & projects */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        <nav aria-label="Primary navigation" className="space-y-1">
          <div className="px-2.5 pb-1.5 text-[11px] font-medium text-[#73736D]">
            Workspace
          </div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between px-2.5 py-2 text-[13px] font-medium rounded-md transition-colors duration-150 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-[#141413] ${
                  isActive
                    ? 'bg-[#141413] text-white'
                    : 'text-[#52524D] hover:bg-[#EFEFEA] hover:text-[#141413]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                </span>
                {item.id === 'pipelines' && runningJobCount > 0 && (
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      isActive ? 'text-white/80' : 'text-[#2563EB]'
                    }`}
                  >
                    {runningJobCount} active
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-[#E5E5E0] pt-4">
          <div className="px-2.5 pb-2 text-[11px] font-medium text-[#73736D]">
            Repositories
          </div>
          <div className="space-y-1">
            {projects.map((project) => {
              const selected = project.id === activeProjectId;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleProjectClick(project.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 text-left rounded-md transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[#141413] ${
                    selected
                      ? 'bg-white text-[#141413] border border-[#E5E5E0]'
                      : 'text-[#52524D] border border-transparent hover:bg-[#EFEFEA] hover:text-[#141413]'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FolderGit2
                      className="w-3.5 h-3.5 shrink-0 text-[#73736D]"
                      aria-hidden="true"
                    />
                    <span className="truncate text-[13px] font-medium">
                      {project.name}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-[#73736D] shrink-0 pl-2">
                    {project.region}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Operator account footer */}
      <div className="border-t border-[#E5E5E0] p-3 shrink-0 bg-white">
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#EFEFEA] border border-[#E5E5E0] text-xs font-semibold text-[#141413]">
            LJ
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[#141413]">
              Landon Jordan
            </div>
            <div className="truncate text-[11px] text-[#73736D]">
              Platform Infrastructure
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 h-full">
        {sidebarContent}
      </aside>

      {/* Mobile & tablet slide-over drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden flex"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation sidebar"
        >
          <div
            className="fixed inset-0 bg-black/35 transition-opacity"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-68 max-w-[82vw] h-full shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
