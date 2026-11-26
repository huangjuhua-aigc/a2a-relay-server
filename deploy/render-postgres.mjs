#!/usr/bin/env node
// Namespace, migration Job and internal-only workload. ALB/TLS is configured
// separately after the domain/certificate and trusted proxy sources are known.
import { pathToFileURL } from 'node:url'
import { originOf } from '@talk2myagent/a2a-relay-protocol'
export function renderPostgres({stage='workload',origin,image,migrationId='001',registration='closed',caSecret,trustedProxyIPs='',namespace='a2a-relay',imagePullSecret}) {
  const publicOrigin=originOf(origin??'')
  if(!image||image.endsWith(':latest')||!/@sha256:[a-f0-9]{64}$|:[a-zA-Z0-9_.-]+$/.test(image))throw new Error('Set a release-tagged RELAY_IMAGE')
  if(!['migrate','workload'].includes(stage))throw new Error('stage must be migrate or workload')
  if(!/^[a-z0-9-]{1,40}$/.test(migrationId))throw new Error('Invalid migration ID')
  if(!['closed','open'].includes(registration))throw new Error('Invalid registration mode')
  if(caSecret&&!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(caSecret))throw new Error('Invalid CA Secret name')
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))throw new Error('Invalid namespace')
  if(imagePullSecret&&!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(imagePullSecret))throw new Error('Invalid image pull Secret name')
  const ns=namespace,labels={'app.kubernetes.io/name':'a2a-relay'},meta=name=>({name,namespace:ns,labels})
  const securityContext={allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}}
  const dbEnv=[{name:'RELAY_STORE',value:'postgres'},{name:'RELAY_DATABASE_URL_FILE',value:'/run/database/url'},...(caSecret?[{name:'RELAY_PG_CA_FILE',value:'/run/database-ca/ca.crt'}]:[])]
  const mounts=[{name:'database',mountPath:'/run/database',readOnly:true},...(caSecret?[{name:'database-ca',mountPath:'/run/database-ca',readOnly:true}]:[])]
  const pod={automountServiceAccountToken:false,terminationGracePeriodSeconds:30,
    ...(imagePullSecret?{imagePullSecrets:[{name:imagePullSecret}]}:{}),
    securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,fsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},
    volumes:[{name:'database',secret:{secretName:stage==='migrate'?'a2a-relay-db-migration':'a2a-relay-db',defaultMode:0o440}},...(caSecret?[{name:'database-ca',secret:{secretName:caSecret,defaultMode:0o440}}]:[])]}
  const namespaceResource={apiVersion:'v1',kind:'Namespace',metadata:{name:ns,labels}}
  if(stage==='migrate')return{apiVersion:'v1',kind:'List',items:[namespaceResource,{apiVersion:'batch/v1',kind:'Job',metadata:meta(`a2a-relay-migrate-${migrationId}`),spec:{backoffLimit:0,activeDeadlineSeconds:120,ttlSecondsAfterFinished:86400,
    template:{spec:{...pod,restartPolicy:'Never',containers:[{name:'migrate',image,command:['node','src/database.mjs','migrate'],env:dbEnv,securityContext,volumeMounts:mounts,
      resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'256Mi'}}}]}}}}]}
  return {apiVersion:'v1',kind:'List',items:[namespaceResource,
    {apiVersion:'v1',kind:'Service',metadata:meta('a2a-relay'),spec:{type:'ClusterIP',selector:labels,ports:[{name:'http',port:8787,targetPort:'http'}]}},
    {apiVersion:'apps/v1',kind:'Deployment',metadata:meta('a2a-relay'),spec:{replicas:1,strategy:{type:'Recreate'},selector:{matchLabels:labels},template:{metadata:{labels},spec:{...pod,
      containers:[{name:'relay',image,securityContext,volumeMounts:mounts,ports:[{name:'http',containerPort:8787}],
        env:[...dbEnv,{name:'RELAY_ORIGIN',value:publicOrigin},{name:'RELAY_BIND',value:'0.0.0.0'},{name:'PORT',value:'8787'},
          {name:'RELAY_REGISTRATION',value:registration},{name:'RELAY_TRUSTED_PROXY_IPS',value:trustedProxyIPs}],
        resources:{requests:{cpu:'250m',memory:'256Mi'},limits:{cpu:'1',memory:'512Mi'}},
        startupProbe:{httpGet:{path:'/health',port:'http'},periodSeconds:3,failureThreshold:20},
        livenessProbe:{httpGet:{path:'/health',port:'http'},periodSeconds:30,timeoutSeconds:3},
        readinessProbe:{httpGet:{path:'/ready',port:'http'},periodSeconds:10,timeoutSeconds:7},
      }]}}}},
  ]}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(renderPostgres({stage:process.argv[2],origin:process.env.RELAY_ORIGIN,image:process.env.RELAY_IMAGE,
    migrationId:process.env.RELAY_MIGRATION_ID,registration:process.env.RELAY_REGISTRATION,caSecret:process.env.RELAY_PG_CA_SECRET,
    trustedProxyIPs:process.env.RELAY_TRUSTED_PROXY_IPS,namespace:process.env.RELAY_NAMESPACE,imagePullSecret:process.env.RELAY_IMAGE_PULL_SECRET}),null,2))}
  catch{console.error('Cannot render PostgreSQL workload. Check origin, release image, migration ID and Secret names.');process.exitCode=1}
}
