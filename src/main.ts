import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";
import * as azure from "@pulumi/azure";
import * as azuread from "@pulumi/azuread";

let config = new pulumi.Config("azure");
async function createResources() {
    const resourceGroup = new azure.core.ResourceGroup("resourceGroup", {
        location: config.require("location"),
        name: `${config.require("name")}Cluster`,
    });

    const currentUser = await azuread.getClientConfig({});
    const application = new azuread.Application("spApplication", {
        displayName: "kubernetesApplication",
        owners: [currentUser.objectId],
    });
    const servicePrincipal = new azuread.ServicePrincipal("k8sServicePrincipal", {
        applicationId: application.applicationId,
        appRoleAssignmentRequired: false,
        owners: [currentUser.objectId],
    });

    const k8sCluster = new azure_native.containerservice.ManagedCluster(
        "k8sCluster",
        {
            resourceGroupName: resourceGroup.name,
            enableRBAC: true,
            servicePrincipalProfile: {
                clientId: servicePrincipal.applicationId,
            },
            autoScalerProfile: {
                scaleDownDelayAfterAdd: "15m",
                scanInterval: "20s",
            },
            kubernetesVersion: "1.27.1",
            location: config.require("location"),
            sku: {
                name: "Standard",
                tier: "Paid",
            },
            agentPoolProfiles: [
                {
                    name: "systempool1",
                    count: 3,
                    enableNodePublicIP: false,
                    enableAutoScaling: true,
                    vmSize: "Standard_DS2_v2",
                    osType: "Linux",
                    mode: "system",
                },
                {
                    name: "userpool1",
                    count: 3,
                    enableNodePublicIP: false,
                    enableAutoScaling: true,
                    vmSize: "Standard_B8ms",
                    osType: "Linux",
                    mode: "user",
                },
            ],
        },
    );
}

createResources();
