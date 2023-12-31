import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";
import * as azure from "@pulumi/azure";
import * as azuread from "@pulumi/azuread";
import * as kubernetes from "@pulumi/kubernetes";

let config = new pulumi.Config("azure");

async function createCluster(): Promise<azure_native.containerservice.ManagedCluster> {
    const resourceGroup = new azure.core.ResourceGroup("resourceGroup", {
        location: config.require("location"),
        name: `${config.require("name")}-resources`,
    });

    const currentUser = await azuread.getClientConfig({});
    const application = new azuread.Application("spApplication", {
        displayName: "kubernetesApplication",
        owners: [currentUser.objectId],
    });
    const servicePrincipal = new azuread.ServicePrincipal(
        "k8sServicePrincipal",
        {
            applicationId: application.applicationId,
            appRoleAssignmentRequired: false,
            owners: [currentUser.objectId],
        },
    );

    return new azure_native.containerservice.ManagedCluster("k8sCluster", {
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
    });
}

async function createAADRoles() {
    const currentUser = await azuread.getClientConfig({});
    const sreGroup = new azuread.Group("sreGroup", {
        displayName: "SRE",
        owners: [currentUser.objectId],
        securityEnabled: true,
    });

    const developerGroup = new azuread.Group("developerGroup", {
        displayName: "Developer",
        owners: [currentUser.objectId],
        securityEnabled: true,
    });
    return [developerGroup, sreGroup];
}

async function createRBAC(
    cluster: azure_native.containerservice.ManagedCluster,
) {
    const SreClusterRole = new kubernetes.rbac.v1.ClusterRole(
        "SreClusterRole",
        {
            metadata: {
                name: "SRE",
            },
            rules: [
                {
                    apiGroups: ["*"],
                    resources: ["*"],
                    verbs: ["*"],
                },
            ],
        },
        {
            dependsOn: cluster,
        },
    );

    const DeveloperClusterRole = new kubernetes.rbac.v1.ClusterRole(
        "DeveloperClusterRole",
        {
            metadata: {
                name: "Developer",
            },
            rules: [
                {
                    apiGroups: [""],
                    resources: [
                        "pods",
                        "services",
                        "configmaps",
                        "persistentvolumeclaims",
                        "secrets",
                    ],
                    verbs: ["get", "list", "watch"],
                },
                {
                    apiGroups: ["apps"],
                    resources: ["deployments", "replicasets", "statefulsets"],
                    verbs: ["get", "list", "watch"],
                },
                {
                    apiGroups: ["batch"],
                    resources: ["cronjobs"],
                    verbs: ["get", "list", "watch"],
                },
                {
                    apiGroups: ["extensions"],
                    resources: ["ingresses"],
                    verbs: ["get", "list", "watch"],
                },
                {
                    apiGroups: ["networking.k8s.io"],
                    resources: ["networkpolicies"],
                    verbs: ["get", "list", "watch"],
                },
            ],
        },
    );
}

async function createBindings(
    developerGroup: azuread.Group,
    sreGroup: azuread.Group,
) {
    const DeveloperBinding = new kubernetes.rbac.v1.ClusterRoleBinding(
        "DeveloperBinding",
        {
            metadata: {
                name: "DeveloperBinding",
            },
            roleRef: {
                apiGroup: "rbac.authorization.k8s.io",
                kind: "ClusterRole",
                name: "Developer",
            },
            subjects: [
                {
                    kind: "Group",
                    name: developerGroup.objectId,
                },
            ],
        },
    );

    const SreBinding = new kubernetes.rbac.v1.ClusterRoleBinding("SREBinding", {
        metadata: {
            name: "SREBinding",
        },
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: "SRE",
        },
        subjects: [
            {
                kind: "Group",
                name: sreGroup.objectId,
            },
        ],
    });
}

async function createHelmCharts(
    cluster: azure_native.containerservice.ManagedCluster,
) {
    const nginxIngress = new kubernetes.helm.v3.Release(
        "nginxIngress",
        {
            name: "nginx",
            chart: "ingress-nginx",
            version: "4.8.2",
            cleanupOnFail: true,
            forceUpdate: true,
            repositoryOpts: {
                repo: "https://kubernetes.github.io/ingress-nginx",
            },
        },
        {
            dependsOn: cluster,
        },
    );

    const prometheusStack = new kubernetes.helm.v3.Release(
        "prometheus",
        {
            chart: "kube-prometheus-stack",
            name: "prometheus",
            version: "51.9.2",
            cleanupOnFail: true,
            forceUpdate: true,
            repositoryOpts: {
                repo: "https://prometheus-community.github.io/helm-charts",
            },
        },
        {
            dependsOn: cluster,
        },
    );
}

async function connectToCluster(name: string, resourceGroup: string) {
    Bun.spawn(
        `az aks get-credentials --resource-group ${resourceGroup} --name ${name}`.split(
            " ",
        ),
    );
}

async function createResources() {
    const cluster = await createCluster();
    cluster.name.apply((name) =>
        connectToCluster(name, `${config.require("name")}-resources`),
    );
    const roles = await createAADRoles();
    createRBAC(cluster);
    createBindings(roles[0], roles[1]);
    createHelmCharts(cluster);
}

createResources();
