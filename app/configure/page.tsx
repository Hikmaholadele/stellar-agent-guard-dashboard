import { CommandPalette } from "../../components/CommandPalette.tsx";
import { GuardProvider } from "../../components/GuardProvider.tsx";
import { WalletBar } from "../../components/WalletBar.tsx";
import { ConfigureNetworkContext } from "../../components/ConfigureNetworkContext.tsx";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { SetupWizard } from "../../components/SetupWizard.tsx";
import { HardwareWalletGuide } from "../../components/HardwareWalletGuide.tsx";
import { ScopeNotice } from "../../components/bits.tsx";

export default function ConfigurePage() {
  return (
    <GuardProvider>
      <HardwareWalletGuide />
      <header className="configure-header">
        <h2>Configure</h2>
        <ConfigureNetworkContext />
      </header>
      <WalletBar />
      <SetupWizard />
      <DeployPanel />
      <PolicyForm />
      <ScopeNotice compact />
    </GuardProvider>
  );
}
