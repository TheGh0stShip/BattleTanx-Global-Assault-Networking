@description('Azure region for every relay resource.')
param location string = resourceGroup().location

@description('Short resource-name prefix.')
@minLength(3)
@maxLength(24)
param namePrefix string = 'btga-relay'

@description('Globally unique DNS label. The resulting hostname is returned as relayHost.')
@minLength(3)
@maxLength(63)
param dnsLabelPrefix string

@description('Linux administrator account retained for Azure serial-console recovery; SSH ingress is not exposed.')
param adminUsername string = 'btgaadmin'

@description('OpenSSH public key for the administrator account.')
@secure()
param adminSshPublicKey string

@description('Relay UDP port. Clients make outbound connections to this port; no client port forwarding is used.')
@minValue(1024)
@maxValue(65535)
param relayPort int = 30420

@description('Smallest practical production VM. Override only after reviewing recurring cost.')
param vmSize string = 'Standard_B1ls'

@description('Email address that receives resource-group cost alerts.')
@secure()
param budgetContactEmail string

@description('Budget period start. Azure requires the first day of a month.')
param budgetStartDate string = utcNow('yyyy-MM-01')

var publicIpName = '${namePrefix}-ip'
var nsgName = '${namePrefix}-nsg'
var nicName = '${namePrefix}-nic'
var vmName = '${namePrefix}-vm'

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: publicIpName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabelPrefix
    }
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowRelayUdp'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Udp'
          sourcePortRange: '*'
          destinationPortRange: string(relayPort)
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'relay'
        properties: {
          addressPrefix: '10.42.0.0/27'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: nicName
  location: location
  properties: {
    enableAcceleratedNetworking: false
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'relay')
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: 'btga-relay'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 32
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            primary: true
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource monthlyBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${namePrefix}-monthly-60-usd'
  properties: {
    amount: 60
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      Actual50: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: []
      }
      Actual75: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 75
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: []
      }
      Forecast80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Forecasted'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: []
      }
      Actual90: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: []
      }
    }
  }
}

output relayHost string = publicIp.properties.dnsSettings.fqdn
output relayIp string = publicIp.properties.ipAddress
output relayPort int = relayPort
output vmResourceId string = vm.id
output monthlyBudgetUsd int = 60
